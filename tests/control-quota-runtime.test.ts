import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaGate, MONITOR_MIN_INTERVAL_MS } from "../control/quota";
import { runMonitor, type BudgetState } from "../control/monitor";
import type { ControlEnv } from "../control/env";

vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(protected ctx: DurableObjectState, protected env: unknown) {} } }));
vi.mock("../control/monitor", () => ({ runMonitor: vi.fn() }));

const databases: DatabaseSync[] = [];
const now = Date.parse("2026-10-28T12:00:00Z");
const state: BudgetState = { mode: "normal", reason: "within_budget", source: "billable-usage", coverage: [], updatedAt: new Date(now).toISOString(), estimatedUsd: 5 };

function runtime() {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const storage = { sql: { exec(query: string, ...values: SQLInputValue[]) {
        if (query.includes("CREATE TABLE")) { database.exec(query); return; }
        const rows = database.prepare(query).all(...values);
        return { toArray: () => rows };
    } } };
    const env = {} as ControlEnv;
    const construct = () => Reflect.construct(QuotaGate, [{ storage }, env]) as QuotaGate;
    return { database, env, gate: construct(), construct };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.mocked(runMonitor).mockReset().mockResolvedValue(state);
});
afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
});

describe("serialized account monitor Durable Object", () => {
    it("coalesces overlapping checks while every underlying write remains awaited", async () => {
        const f = runtime();
        let complete!: (value: BudgetState) => void;
        vi.mocked(runMonitor).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
        const first = f.gate.checkBudget();
        const second = f.gate.checkBudget();
        vi.advanceTimersByTime(3_600_000);
        const third = f.gate.checkBudget();
        expect(runMonitor).toHaveBeenCalledExactlyOnceWith(f.env, { failClosed: false });
        expect(f.database.prepare("SELECT completed_at FROM monitor_execution").get()?.completed_at).toBeNull();
        complete(state);
        expect(await Promise.all([first, second, third])).toEqual([state, state, state]);
        expect(f.database.prepare("SELECT completed_at FROM monitor_execution").get()?.completed_at).toBe(now + 3_600_000);
    });

    it("caches the completed result across object restarts until the KV write interval is safely clear", async () => {
        const f = runtime();
        expect(await f.gate.checkBudget()).toEqual(state);
        vi.advanceTimersByTime(MONITOR_MIN_INTERVAL_MS - 1);
        expect(await f.construct().checkBudget()).toEqual(state);
        expect(runMonitor).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(await f.construct().checkBudget()).toEqual(state);
        expect(runMonitor).toHaveBeenCalledTimes(2);
    });

    it("does not immediately retry an interrupted run and forces maintenance on its next bounded pass", async () => {
        const f = runtime();
        vi.mocked(runMonitor).mockRejectedValueOnce(new Error("Uncertain write completion"));
        await expect(f.gate.checkBudget()).rejects.toThrow("Uncertain write completion");
        await expect(f.construct().checkBudget()).rejects.toThrow("MONITOR_PREVIOUS_OUTCOME_UNKNOWN");
        expect(runMonitor).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(MONITOR_MIN_INTERVAL_MS);
        await f.construct().checkBudget();
        expect(runMonitor).toHaveBeenLastCalledWith(f.env, { failClosed: true });
    });
});
