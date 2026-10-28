import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../control/index";
import { activateEdgeStops, monitorStopTargets } from "../control/monitor";
import type { ControlEnv } from "../control/env";

vi.mock("../worker/quota", () => ({ QuotaGate: class {} }));
vi.mock("../control/monitor", () => ({
    activateEdgeStops: vi.fn(async () => ({ verified: { dynamic: true, media: true } })),
    monitorStopTargets: vi.fn(() => []),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("account monitor Worker", () => {
    it("exposes no HTTP endpoint for changing account state", async () => {
        const response = await worker.fetch();
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(activateEdgeStops).not.toHaveBeenCalled();
    });

    it.each([false, true])("runs one scheduled check without retrying after failure=%s", async (failure) => {
        const pending: Promise<unknown>[] = [];
        const checkBudget = vi.fn(async () => undefined);
        const env = Object.assign({} as ControlEnv, { QUOTA: { getByName: vi.fn(() => ({ checkBudget })) } });
        if (failure) checkBudget.mockRejectedValueOnce(new Error("Account source unavailable"));
        const ctx = Object.assign({} as ExecutionContext, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
        await worker.scheduled({} as ScheduledController, env, ctx);
        await expect(Promise.all(pending)).resolves.toBeDefined();
        expect(checkBudget).toHaveBeenCalledExactlyOnceWith();
        expect(env.QUOTA.getByName).toHaveBeenCalledExactlyOnceWith("account-monitor");
        expect(activateEdgeStops).toHaveBeenCalledTimes(failure ? 1 : 0);
        if (failure) expect(monitorStopTargets).toHaveBeenCalledExactlyOnceWith(env, { production: true, test: true });
        expect(pending).toHaveLength(1);
    });
});
