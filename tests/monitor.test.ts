import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateUsage, nextBudgetState, runMonitor, type BudgetState } from "../worker/monitor";
import type { SupportEnv } from "../worker/env";

const now = Date.parse("2026-10-26T12:00:00Z");
function usage(cost: number) {
    const base = { BillingCurrency: "USD", CumulatedContractedCost: cost, ChargePeriodEnd: "2026-10-26T00:00:00Z", BillingPeriodStart: "2026-10-01T00:00:00Z", PricingUnit: "requests" };
    return { success: true, result: [
        { ...base, ServiceName: "Workers Standard", ServiceFamilyName: "Workers" },
        ...["D1", "R2", "Durable Objects", "Email Sending", "Workers Logs", "Workers KV"].map((name) => ({ ...base, ServiceName: name, ServiceFamilyName: name, CumulatedContractedCost: 0 })),
    ] };
}
afterEach(() => vi.unstubAllGlobals());
describe("budget safety", () => {
    it("counts cumulative rows once and includes the recurring-plan reserve", () => {
        const data = usage(6);
        data.result.push({ ...data.result[0], CumulatedContractedCost: 4, ChargePeriodEnd: "2026-10-25T00:00:00Z" });
        expect(estimateUsage(data, now).estimatedUsd).toBe(11);
    });
    it("never treats an absent, stale or foreign-currency feed as zero cost", () => {
        expect(() => estimateUsage({ success: false }, now)).toThrow();
        expect(() => estimateUsage({ success: true, result: [] }, now)).toThrow();
        expect(() => estimateUsage(usage(1), now + 48 * 3_600_000)).toThrow();
        const euro = usage(1); euro.result[0].BillingCurrency = "EUR";
        expect(() => estimateUsage(euro, now)).toThrow();
        const incomplete = usage(1); incomplete.result.pop();
        expect(() => estimateUsage(incomplete, now)).toThrow("USAGE_COVERAGE_INCOMPLETE");
        expect(() => estimateUsage({ ...usage(1), result_info: { total_count: 100, total_pages: 2 } }, now)).toThrow("USAGE_DATA_TRUNCATED");
    });
    it("escalates at the agreed thresholds and requires manual recovery", () => {
        const restricted = nextBudgetState(null, { estimatedUsd: 15, coverage: [] }, now);
        expect(restricted.mode).toBe("restricted");
        const stopped = nextBudgetState(restricted, { estimatedUsd: 18, coverage: [] }, now);
        expect(stopped.mode).toBe("maintenance");
        expect(nextBudgetState(stopped, { estimatedUsd: 5, coverage: [] }, now).mode).toBe("maintenance");
        expect(nextBudgetState(null, null, now).mode).toBe("restricted");
    });
    it("a 403 costs-feed error persists restricted mode with one request and no retry", async () => {
        const values = new Map<string, string>();
        const env = {
            CF_MONITOR_TOKEN: "test-token", CF_ACCOUNT_ID: "a".repeat(32), ALERT_EMAIL: "",
            STATE: {
                async get(key: string) { const value = values.get(key); return value ? JSON.parse(value) : null; },
                async put(key: string, value: string) { values.set(key, value); },
            },
        } as SupportEnv;
        const fetcher = vi.fn(async () => new Response("Forbidden", { status: 403 }));
        vi.stubGlobal("fetch", fetcher);
        const result = await runMonitor(env);
        expect(result.mode).toBe("restricted");
        expect(result.estimatedUsd).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(values.get("budget:state")!) as BudgetState).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
    });
});
