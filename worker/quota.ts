import { DurableObject } from "cloudflare:workers";
import { reserveQuota, validQuotaRequest, type QuotaTransaction } from "./quota-core";
import type { SupportEnv } from "./env";
import { readBounded } from "./http";

export const QUOTA_LEDGER_MAX_ENTRIES = 100_000;
export const QUOTA_REQUEST_CLEANUP_BATCH = 32;
export const QUOTA_ALARM_CLEANUP_BATCH = 1000;
export const QUOTA_CLEANUP_DELAY_MS = 60_000;

const CAPACITY_ERROR = "QUOTA_LEDGER_CAPACITY";
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS quota_entries (
        key TEXT PRIMARY KEY CHECK(length(key) <= 256),
        value TEXT NOT NULL CHECK(length(value) <= 128),
        expires_at INTEGER NOT NULL CHECK(expires_at >= 0)
    );
    CREATE INDEX IF NOT EXISTS quota_entries_expiry ON quota_entries(expires_at, key);
    CREATE TABLE IF NOT EXISTS quota_ledger (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        entries INTEGER NOT NULL CHECK(entries BETWEEN 0 AND ${QUOTA_LEDGER_MAX_ENTRIES})
    );
    INSERT OR IGNORE INTO quota_ledger(id, entries) VALUES(1, 0);
    CREATE TRIGGER IF NOT EXISTS quota_capacity BEFORE INSERT ON quota_entries
    WHEN NOT EXISTS(SELECT 1 FROM quota_entries WHERE key = NEW.key)
        AND (SELECT entries FROM quota_ledger WHERE id = 1) >= ${QUOTA_LEDGER_MAX_ENTRIES}
    BEGIN SELECT RAISE(ABORT, '${CAPACITY_ERROR}'); END;
    CREATE TRIGGER IF NOT EXISTS quota_count_insert AFTER INSERT ON quota_entries
    BEGIN UPDATE quota_ledger SET entries = entries + 1 WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS quota_count_delete AFTER DELETE ON quota_entries
    BEGIN UPDATE quota_ledger SET entries = entries - 1 WHERE id = 1; END;
`;

export class QuotaGate extends DurableObject<SupportEnv> {
    constructor(ctx: DurableObjectState, env: SupportEnv) {
        super(ctx, env);
        this.ctx.storage.sql.exec(SCHEMA);
    }

    private removeExpired(now: number, limit: number): void {
        this.ctx.storage.sql.exec(`
            DELETE FROM quota_entries WHERE key IN (
                SELECT key FROM quota_entries WHERE expires_at <= ?
                ORDER BY expires_at, key LIMIT ?
            )
        `, now, limit);
    }

    private async scheduleCleanup(now: number): Promise<void> {
        const next = this.ctx.storage.sql.exec<{ expires_at: number }>(
            "SELECT expires_at FROM quota_entries ORDER BY expires_at, key LIMIT 1",
        ).toArray()[0];
        const current = await this.ctx.storage.getAlarm();
        if (!next) {
            if (current !== null) await this.ctx.storage.deleteAlarm();
            return;
        }
        // Drain expired backlogs in fixed batches, and sleep until the next expiry
        // otherwise. Never postpone an alarm already scheduled by another request.
        const scheduledAt = Math.max(now + QUOTA_CLEANUP_DELAY_MS, next.expires_at);
        if (current === null || current > scheduledAt) await this.ctx.storage.setAlarm(scheduledAt);
    }

    async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/reserve") return new Response("Not found", { status: 404 });
        const raw = await readBounded(request, 8192);
        if (raw === null) return new Response("Payload too large", { status: 413 });
        let input: unknown;
        try { input = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
        if (!validQuotaRequest(input)) return new Response("Invalid quota request", { status: 400 });
        const now = Date.now();
        try {
            const result = await this.ctx.storage.transaction(async () => {
                let writing = false;
                const tx: QuotaTransaction = {
                    get: async <T>(key: string) => {
                        const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM quota_entries WHERE key = ?", key).toArray()[0];
                        return row ? JSON.parse(row.value) as T : undefined;
                    },
                    put: async <T>(key: string, value: T) => {
                        // Only accepted reservations can delete expired rows. Replays
                        // and exhausted quotas cannot amplify cleanup writes.
                        if (!writing) { this.removeExpired(now, QUOTA_REQUEST_CLEANUP_BATCH); writing = true; }
                        const expiresAt = (value as { expiresAt: number }).expiresAt;
                        this.ctx.storage.sql.exec(`
                            INSERT INTO quota_entries(key, value, expires_at) VALUES(?, ?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
                        `, key, JSON.stringify(value), expiresAt);
                    },
                };
                const outcome = await reserveQuota(tx, input, now);
                // Alarm changes and quota writes share the SQLite storage transaction.
                // A scheduling failure must never authorize an unmaintained reservation.
                await this.scheduleCleanup(now);
                return outcome;
            });
            return Response.json(result, { status: result.allowed ? 200 : 429, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {} });
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes(CAPACITY_ERROR)) throw error;
            // The failed reservation has rolled back completely. Repair an exhausted
            // alarm retry sequence without deleting live counters or allowing writes.
            await this.ctx.storage.transaction(() => this.scheduleCleanup(now));
            return Response.json({ allowed: false, retryAfter: 60 }, { status: 503, headers: { "Retry-After": "60" } });
        }
    }

    async alarm(): Promise<void> {
        await this.ctx.storage.transaction(async () => {
            const now = Date.now();
            this.removeExpired(now, QUOTA_ALARM_CLEANUP_BATCH);
            await this.scheduleCleanup(now);
        });
    }
}
