import { QuotaGate as BaseQuotaGate } from "../worker/quota";
import type { ControlEnv } from "./env";
import { runMonitor, type BudgetState } from "./monitor";

export const MONITOR_MIN_INTERVAL_MS = 61_000;
type Execution = {
    started_at: number;
    completed_at: number | null;
    result: string | null;
};

// This is the control Worker's own namespace. Business quota instances retain
// the base class and cannot invoke account monitoring or access its bindings.
export class QuotaGate extends BaseQuotaGate {
    private readonly controlEnv: ControlEnv;
    private running: Promise<BudgetState> | null = null;

    constructor(ctx: DurableObjectState, env: ControlEnv) {
        super(ctx, env);
        this.controlEnv = env;
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS monitor_execution (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                result TEXT
            );
        `);
    }

    async checkBudget(): Promise<BudgetState> {
        // Keep the entire operation inside this one object. Never expire an
        // external lease while an uncertain KV/WAF write is still pending.
        if (this.running) return this.running;
        const previous = this.ctx.storage.sql.exec<Execution>("SELECT started_at, completed_at, result FROM monitor_execution WHERE id = 1").toArray()[0];
        const now = Date.now();
        if (previous && now - (previous.completed_at ?? previous.started_at) < MONITOR_MIN_INTERVAL_MS) {
            if (previous.result && previous.completed_at !== null) return JSON.parse(previous.result) as BudgetState;
            throw new Error("MONITOR_PREVIOUS_OUTCOME_UNKNOWN");
        }
        this.ctx.storage.sql.exec(`
            INSERT INTO monitor_execution(id, started_at, completed_at, result) VALUES(1, ?, NULL, NULL)
            ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, completed_at = NULL, result = NULL
        `, now);
        this.running = (async () => {
            // A restarted object cannot assume an interrupted write failed.
            // Its next bounded pass closes both environments for manual review.
            const state = await runMonitor(this.controlEnv, { failClosed: Boolean(previous && previous.completed_at === null) });
            this.ctx.storage.sql.exec("UPDATE monitor_execution SET completed_at = ?, result = ? WHERE id = 1", Date.now(), JSON.stringify(state));
            return state;
        })();
        try { return await this.running; }
        finally { this.running = null; }
    }
}
