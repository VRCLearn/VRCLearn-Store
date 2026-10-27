import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    QuotaGate, QUOTA_ALARM_CLEANUP_BATCH, QUOTA_CLEANUP_DELAY_MS,
    QUOTA_LEDGER_MAX_ENTRIES, QUOTA_REQUEST_CLEANUP_BATCH,
} from "../worker/quota";
import type { QuotaRequest } from "../worker/quota-core";

vi.mock("cloudflare:workers", () => ({
    DurableObject: class {
        constructor(protected ctx: DurableObjectState, protected env: unknown) {}
    },
}));

const databases: DatabaseSync[] = [];
const now = Date.parse("2026-10-27T12:00:00Z");

// Run the production DO methods and their SQL against SQLite. Only the runtime
// context (transaction serialization and durable alarm API) is supplied here.
function runtime() {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    let alarmAt: number | null = null;
    let pending = Promise.resolve();
    let failCleanup = false;
    let failAlarm = false;
    const sql = {
        exec(query: string, ...bindings: SQLInputValue[]) {
            if (query.includes("CREATE TABLE")) { database.exec(query); return; }
            if (failCleanup && query.includes("DELETE FROM quota_entries")) throw new Error("storage unavailable");
            const rows = database.prepare(query).all(...bindings);
            return { toArray: () => rows };
        },
    };
    const storage = {
        sql,
        transaction<T>(callback: () => Promise<T>): Promise<T> {
            const operation = pending.then(async () => {
                const previousAlarm = alarmAt;
                database.exec("BEGIN");
                try {
                    const result = await callback();
                    database.exec("COMMIT");
                    return result;
                } catch (error) {
                    database.exec("ROLLBACK");
                    alarmAt = previousAlarm;
                    throw error;
                }
            });
            pending = operation.then(() => undefined, () => undefined);
            return operation;
        },
        async getAlarm() { return alarmAt; },
        async setAlarm(value: number) {
            if (failAlarm) throw new Error("alarm unavailable");
            alarmAt = value;
        },
        async deleteAlarm() { alarmAt = null; },
    };
    const gate: QuotaGate = Reflect.construct(QuotaGate, [{ storage }, {}]);
    const count = () => database.prepare("SELECT entries FROM quota_ledger WHERE id = 1").get()!.entries;
    const get = (key: string) => {
        const row = database.prepare("SELECT value FROM quota_entries WHERE key = ?").get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
    };
    const insert = database.prepare("INSERT INTO quota_entries(key, value, expires_at) VALUES(?, ?, ?)");
    function seed(count: number, expiresAt: number, prefix = "seed") {
        database.exec("BEGIN");
        try {
            for (let index = 0; index < count; index++) insert.run(`${prefix}:${index}`, JSON.stringify({ expiresAt }), expiresAt);
            database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
    return {
        database, gate, count, get, seed,
        alarmAt: () => alarmAt,
        failCleanup(value: boolean) { failCleanup = value; },
        failAlarm(value: boolean) { failAlarm = value; },
        async alarm() { alarmAt = null; await gate.alarm(); },
        reserve(input: QuotaRequest) {
            return gate.fetch(new Request("https://quota.internal/reserve", {
                method: "POST", body: JSON.stringify(input),
            }));
        },
    };
}

function reservation(key: string, limit = 10, windowSeconds = 60): QuotaRequest {
    return { key, limits: [{ key: "global", limit, windowSeconds }] };
}

afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
});

describe("quota ledger cleanup and runtime failures", () => {
    it("drains a full day of expired reservations in bounded indexed batches without touching live entries", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        state.seed(45_000, now - 1, "z-expired");
        state.seed(1, now + 3_600_000, "a-live");
        const plan = state.database.prepare("EXPLAIN QUERY PLAN SELECT key FROM quota_entries WHERE expires_at <= ? ORDER BY expires_at, key LIMIT ?")
            .all(now, QUOTA_ALARM_CLEANUP_BATCH);
        expect(plan.some((row) => String(row.detail).includes("quota_entries_expiry"))).toBe(true);
        for (let batch = 0; batch < 45; batch++) {
            const before = Number(state.count());
            await state.alarm();
            expect(before - Number(state.count())).toBe(QUOTA_ALARM_CLEANUP_BATCH);
            expect(state.get("a-live:0")).toEqual({ expiresAt: now + 3_600_000 });
            if (batch < 44) {
                expect(state.alarmAt()).toBe(now + (batch + 1) * QUOTA_CLEANUP_DELAY_MS);
                vi.advanceTimersByTime(QUOTA_CLEANUP_DELAY_MS);
            }
        }
        expect(state.count()).toBe(1);
        expect(state.alarmAt()).toBe(now + 3_600_000);
        vi.setSystemTime(now + 3_600_000);
        await state.alarm();
        expect(state.count()).toBe(0);
        expect(state.alarmAt()).toBeNull();
    });

    it("never turns denied requests or replays into cleanup writes", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        expect((await state.reserve(reservation("first:request", 1))).status).toBe(200);
        state.seed(100, now - 1);
        const before = Number(state.count());
        expect((await state.reserve(reservation("second:request", 1))).status).toBe(429);
        expect((await state.reserve(reservation("first:request", 1))).status).toBe(429);
        expect(state.count()).toBe(before);
        const accepted = await state.reserve({ key: "other:request", limits: [{ key: "other", limit: 1, windowSeconds: 60 }] });
        expect(accepted.status).toBe(200);
        expect(state.count()).toBe(before - QUOTA_REQUEST_CLEANUP_BATCH + 2);
    });

    it("caps the ledger and rolls back every counter when a reservation would overfill it", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        const initial = reservation("initial:request", 10);
        expect((await state.reserve(initial)).status).toBe(200);
        state.seed(QUOTA_LEDGER_MAX_ENTRIES - 3, now + 3_600_000);
        const before = Number(state.count());
        expect(before).toBe(QUOTA_LEDGER_MAX_ENTRIES - 1);
        const start = Math.floor(now / 60_000) * 60_000;
        const response = await state.reserve({ key: "capacity:request", limits: [
            { key: "global", limit: 10, windowSeconds: 60 },
            { key: "new-counter", limit: 10, windowSeconds: 60 },
        ] });
        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("60");
        expect(state.count()).toBe(before);
        expect(state.get(`counter:global:${start}`)).toMatchObject({ used: 1 });
        expect(state.get(`counter:new-counter:${start}`)).toBeUndefined();
        expect(state.get("reservation:capacity:request")).toBeUndefined();
        state.seed(1, now + 3_600_000, "last");
        expect(state.count()).toBe(QUOTA_LEDGER_MAX_ENTRIES);
        expect(() => state.seed(1, now + 3_600_000, "overflow")).toThrow("QUOTA_LEDGER_CAPACITY");
        expect(state.count()).toBe(QUOTA_LEDGER_MAX_ENTRIES);
    });

    it("atomically rolls back reservations when the cleanup alarm cannot be persisted", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        state.seed(100, now - 1);
        state.failAlarm(true);
        await expect(state.reserve(reservation("schedule:failure"))).rejects.toThrow("alarm unavailable");
        expect(state.count()).toBe(100);
        expect(state.get("reservation:schedule:failure")).toBeUndefined();
        expect(state.alarmAt()).toBeNull();
        state.failAlarm(false);
        expect((await state.reserve(reservation("schedule:failure"))).status).toBe(200);
        expect(state.count()).toBe(100 - QUOTA_REQUEST_CLEANUP_BATCH + 2);
    });

    it("propagates alarm failures for runtime retries and resumes idempotently", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        state.seed(QUOTA_ALARM_CLEANUP_BATCH + 1, now - 1);
        state.failCleanup(true);
        await expect(state.alarm()).rejects.toThrow("storage unavailable");
        expect(state.count()).toBe(QUOTA_ALARM_CLEANUP_BATCH + 1);
        state.failCleanup(false);
        await state.alarm();
        expect(state.count()).toBe(1);
        expect(state.alarmAt()).toBe(now + QUOTA_CLEANUP_DELAY_MS);
        vi.advanceTimersByTime(QUOTA_CLEANUP_DELAY_MS);
        await state.alarm();
        expect(state.count()).toBe(0);
        expect(state.alarmAt()).toBeNull();
        await state.alarm();
        expect(state.alarmAt()).toBeNull();
    });

    it("moves an alarm earlier for a shorter window without postponing it on later traffic", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        expect((await state.reserve(reservation("long:first", 100, 86_400))).status).toBe(200);
        expect(state.alarmAt()).toBe(now + 3_600_000);
        expect((await state.reserve({ key: "short:request", limits: [{ key: "short", limit: 10, windowSeconds: 60 }] })).status).toBe(200);
        expect(state.alarmAt()).toBe(now + QUOTA_CLEANUP_DELAY_MS);
        vi.advanceTimersByTime(1000);
        expect((await state.reserve(reservation("long:second", 100, 86_400))).status).toBe(200);
        expect(state.alarmAt()).toBe(now + QUOTA_CLEANUP_DELAY_MS);
    });

    it("keeps exact limits and replay rejection under concurrent production method calls", async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const state = runtime();
        const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => state.reserve(reservation(`parallel:${index}`, 5))));
        expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
        expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
        const start = Math.floor(now / 60_000) * 60_000;
        expect(state.get(`counter:global:${start}`)).toMatchObject({ used: 5 });
        expect(state.count()).toBe(6);
    });

    it("rejects malformed limit objects before touching the ledger", async () => {
        const state = runtime();
        const response = await state.gate.fetch(new Request("https://quota.internal/reserve", {
            method: "POST", body: JSON.stringify({ key: "invalid:request", limits: [null] }),
        }));
        expect(response.status).toBe(400);
        expect(state.count()).toBe(0);
        expect(state.alarmAt()).toBeNull();
    });
});
