import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dynamicBlockExpression, estimateUsage, mediaBlockExpression, nextBudgetState, runMonitor, type BudgetState } from "../worker/monitor";
import type { SupportEnv } from "../worker/env";

const now = Date.parse("2026-10-26T12:00:00Z");
const currentStart = "2026-10-01T00:00:00Z";
const currentEnd = "2026-10-26T00:00:00Z";
const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const rulesetId = "c".repeat(32);
const dynamicId = "d".repeat(32);
const mediaId = "e".repeat(32);
const billingBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/billable-usage`;
const rulesBase = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets`;
const entrypoint = `${rulesBase}/phases/http_request_firewall_custom/entrypoint`;

interface UsageRow {
    BillingCurrency: string;
    CumulatedContractedCost: number;
    ChargePeriodEnd: string;
    BillingPeriodStart: string;
    PricingUnit: string;
    ChargeDescription: string;
    ServiceName: string;
    ServiceFamilyName: string;
    SubscriptionId?: string;
    x_BillableMetricId?: string;
    ZoneId?: string;
}
function usage(cost: number, end = currentEnd, start = currentStart) {
    const base = { BillingCurrency: "USD", CumulatedContractedCost: 0, ChargePeriodEnd: end, BillingPeriodStart: start, PricingUnit: "requests" };
    const result: UsageRow[] = [
        { ...base, ServiceName: "Workers Standard", ServiceFamilyName: "Workers", ChargeDescription: "Workers Standard requests", CumulatedContractedCost: cost },
        ...["D1", "R2", "Durable Objects", "Email Sending", "Workers Logs", "Workers KV"].map((name) => ({ ...base, ServiceName: name, ServiceFamilyName: name, ChargeDescription: `${name} requests` })),
    ];
    return { success: true, result };
}
function usageInfo(anchor = "2026-09-01T00:00:00Z") {
    return { success: true, result: { covered: true, subscriptions: [{ id: "subscription-one", billing_cycle_anchor_timestamp: anchor, start_timestamp: anchor }] } };
}
function budget(mode: BudgetState["mode"], estimatedUsd = 5): BudgetState {
    return { mode, estimatedUsd, reason: "within_budget", updatedAt: new Date(now).toISOString(), source: "billable-usage", coverage: [] };
}
interface Rule { id: string; action: string; expression: string; enabled: boolean }
function fixture(cost = 13) {
    const state = new Map<string, string>();
    const get = vi.fn(async (key: string) => {
        const value = state.get(key);
        return value === undefined ? null : JSON.parse(value) as unknown;
    });
    const put = vi.fn(async (key: string, value: string) => { state.set(key, value); });
    const quotaFetch = vi.fn(async (_request: Request) => Response.json({ allowed: true }));
    const send = vi.fn(async () => ({ messageId: "test-alert" }));
    const env: SupportEnv = Object.assign({} as SupportEnv, {
        CF_MONITOR_TOKEN: "test-monitor-token", CF_API_TOKEN: "test-rule-token", CF_ACCOUNT_ID: accountId, CF_ZONE_ID: zoneId,
        EDGE_RULESET_ID: rulesetId, EDGE_RULE_ID: dynamicId, EDGE_MEDIA_RULE_ID: mediaId,
        ORIGIN: "https://store.vrclearn.com", MEDIA_ORIGIN: "https://store-media.vrclearn.com", ENVIRONMENT: "production",
        ALERT_EMAIL: "", EMAIL_FROM: "noreply@vrclearn.com",
        STATE: Object.assign({} as KVNamespace, { get, put }),
        QUOTA: Object.assign({} as SupportEnv["QUOTA"], { getByName: () => ({ fetch: quotaFetch }) }),
        EMAIL: Object.assign({} as SendEmail, { send }),
    });
    const rules: Rule[] = [
        { id: dynamicId, action: "block", expression: dynamicBlockExpression(env.ORIGIN), enabled: false },
        { id: mediaId, action: "block", expression: mediaBlockExpression(env.MEDIA_ORIGIN), enabled: false },
    ];
    const document = () => ({ success: true, result: { id: rulesetId, kind: "zone", phase: "http_request_firewall_custom", rules } });
    const info = vi.fn(async () => Response.json(usageInfo()));
    const data = vi.fn(async () => Response.json(usage(cost)));
    const edgeRead = vi.fn(async () => Response.json(document()));
    const edgePatch = vi.fn(async (id: string) => {
        const rule = rules.find((entry) => entry.id === id);
        if (!rule) throw new Error("Unexpected rule mutation");
        rule.enabled = true;
        return Response.json({ success: true });
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === `${billingBase}/info`) return info();
        if (url === billingBase) return data();
        if (url === entrypoint && (init?.method ?? "GET") === "GET") return edgeRead();
        if (init?.method === "PATCH" && url.startsWith(`${rulesBase}/${rulesetId}/rules/`)) return edgePatch(url.split("/").at(-1)!);
        throw new Error(`Unexpected external request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    return { env, state, get, put, quotaFetch, send, rules, document, info, data, edgeRead, edgePatch, fetcher };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("billing period and source validation", () => {
    it("counts cumulative daily rows once per metric and includes the recurring plan", () => {
        const data = usage(6);
        data.result.push({ ...data.result[0], CumulatedContractedCost: 4, ChargePeriodEnd: "2026-10-25T00:00:00Z" });
        expect(estimateUsage(data, now, usageInfo()).estimatedUsd).toBe(11);
    });
    it.each([undefined, "same-custom-metric"])("sums distinct official charge descriptions even with custom metric ID %s", (metricId) => {
        const data = usage(7);
        data.result[0].ZoneId = zoneId;
        data.result[0].x_BillableMetricId = metricId;
        data.result.push({ ...data.result[0], ChargeDescription: "Workers Standard additional requests" });
        const estimate = estimateUsage(data, now, usageInfo());
        expect(estimate.estimatedUsd).toBe(19);
        expect(nextBudgetState(null, estimate, now).mode).toBe("maintenance");
    });
    describe.each(["ChargeDescription", "PricingUnit"] as const)("required billing dimension %s", (field) => {
        it.each([undefined, "", " \t\r\n", null, 12, false, {}])("rejects missing, blank or malformed value %j", (value) => {
            const data = usage(0);
            const invalid = { ...data, result: [{ ...data.result[0], [field]: value }, ...data.result.slice(1)] };
            expect(() => estimateUsage(invalid, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
        });
    });
    it("sums the same metric from distinct zones rather than collapsing their costs", () => {
        const data = usage(7);
        data.result[0].ZoneId = "1".repeat(32);
        data.result.push({ ...data.result[0], ZoneId: "2".repeat(32) });
        const estimate = estimateUsage(data, now, usageInfo());
        expect(estimate.estimatedUsd).toBe(19);
        expect(nextBudgetState(null, estimate, now).mode).toBe("maintenance");
    });
    it("does not let a fresh metric from one zone hide another zone's stale metric", () => {
        const data = usage(0);
        data.result[0].ZoneId = "1".repeat(32);
        data.result.push({ ...data.result[0], ZoneId: "2".repeat(32), ChargePeriodEnd: "2026-10-23T00:00:00Z" });
        expect(() => estimateUsage(data, now, usageInfo())).toThrow("USAGE_DATA_STALE");
    });
    it("rejects old products even when the Workers record is fresh", () => {
        const data = usage(0, "2026-10-23T00:00:00Z");
        data.result[0].ChargePeriodEnd = currentEnd;
        expect(() => estimateUsage(data, now, usageInfo())).toThrow("USAGE_DATA_STALE");
    });
    it("requires every metric to be current, including a second metric of a covered product", () => {
        const data = usage(0);
        data.result.push({ ...data.result[1], x_BillableMetricId: "separate-storage-metric", ChargePeriodEnd: "2026-10-23T00:00:00Z" });
        expect(() => estimateUsage(data, now, usageInfo())).toThrow("USAGE_DATA_STALE");
    });
    it("reports the oldest current metric timestamp", () => {
        const data = usage(0);
        data.result[1].ChargePeriodEnd = "2026-10-25T10:00:00Z";
        expect(estimateUsage(data, now, usageInfo()).sourceUpdatedAt).toBe("2026-10-25T10:00:00.000Z");
    });
    it("accepts an exact 36 hour source boundary and rejects older data", () => {
        const data = usage(0, "2026-10-25T00:00:00Z");
        expect(estimateUsage(data, now, usageInfo()).estimatedUsd).toBe(5);
        expect(() => estimateUsage(data, now + 1, usageInfo())).toThrow("USAGE_DATA_STALE");
    });
    it("uses the subscription billing anchor rather than assuming the first day of the month", () => {
        const info = usageInfo("2026-09-09T06:00:00Z");
        expect(estimateUsage(usage(2, currentEnd, "2026-10-09T06:00:00Z"), now, info).estimatedUsd).toBe(7);
        expect(() => estimateUsage(usage(2), now, info)).toThrow("USAGE_PERIOD_INVALID");
    });
    it("clamps a month-end anchor to leap day", () => {
        const leapNow = Date.parse("2028-03-01T12:00:00Z");
        const info = usageInfo("2028-01-31T06:00:00Z");
        expect(estimateUsage(usage(0, "2028-03-01T00:00:00Z", "2028-02-29T06:00:00Z"), leapNow, info).estimatedUsd).toBe(5);
        expect(() => estimateUsage(usage(0, "2028-03-01T00:00:00Z", "2028-02-28T06:00:00Z"), leapNow, info)).toThrow("USAGE_PERIOD_INVALID");
    });
    it("rejects a previous billing cycle even if its record timestamp is recent", () => {
        expect(() => estimateUsage(usage(0, currentEnd, "2026-09-01T00:00:00Z"), now, usageInfo())).toThrow("USAGE_PERIOD_INVALID");
    });
    it("rejects records after subscription termination", () => {
        const info = usageInfo();
        const ended = { ...info, result: { ...info.result, subscriptions: [{ ...info.result.subscriptions[0], end_timestamp: "2026-10-25T00:00:00Z" }] } };
        expect(() => estimateUsage(usage(0), now, ended)).toThrow("USAGE_PERIOD_INVALID");
    });
    it("requires explicit subscription IDs when multiple subscriptions exist", () => {
        const info = usageInfo();
        info.result.subscriptions.push({ ...info.result.subscriptions[0], id: "subscription-two" });
        expect(() => estimateUsage(usage(0), now, info)).toThrow("USAGE_PERIOD_INVALID");
        const data = usage(0);
        data.result.forEach((row) => { row.SubscriptionId = "subscription-one"; });
        expect(estimateUsage(data, now, info).estimatedUsd).toBe(5);
        data.result[0].SubscriptionId = "unrecognized";
        expect(() => estimateUsage(data, now, info)).toThrow("USAGE_PERIOD_INVALID");
    });
    it("does not make a current subscription ambiguous because of a historical cancelled subscription", () => {
        const info = usageInfo();
        const historical = {
            id: "historical-subscription", billing_cycle_anchor_timestamp: "2023-01-01T00:00:00Z",
            start_timestamp: "2023-01-01T00:00:00Z", end_timestamp: "2025-12-31T00:00:00Z",
        };
        expect(estimateUsage(usage(0), now, { ...info, result: { ...info.result, subscriptions: [...info.result.subscriptions, historical] } }).estimatedUsd).toBe(5);
    });
    it.each([
        null,
        { success: false },
        { success: true, result: { covered: false, subscriptions: usageInfo().result.subscriptions } },
        { success: true, result: { covered: true, subscriptions: [] } },
        { success: true, result: { covered: true, subscriptions: [usageInfo().result.subscriptions[0], usageInfo().result.subscriptions[0]] } },
        usageInfo("not-a-date"),
        usageInfo("2026-11-01T00:00:00Z"),
    ])("rejects invalid or unverified coverage metadata %j", (info) => {
        expect(() => estimateUsage(usage(0), now, info)).toThrow("USAGE_INFO_INVALID");
    });
    it.each([null, { success: false }, { success: true, result: [] }])("rejects an absent costs feed %j", (data) => {
        expect(() => estimateUsage(data, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
    });
    it("rejects currency mismatches, incomplete coverage, invalid costs and truncated pages", () => {
        const euro = usage(1); euro.result[0].BillingCurrency = "EUR";
        expect(() => estimateUsage(euro, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
        const incomplete = usage(1); incomplete.result.pop();
        expect(() => estimateUsage(incomplete, now, usageInfo())).toThrow("USAGE_COVERAGE_INCOMPLETE");
        for (const cost of [-1, Infinity, NaN]) expect(() => estimateUsage(usage(cost), now, usageInfo())).toThrow("USAGE_DATA_INVALID");
        expect(() => estimateUsage({ ...usage(1), result_info: { total_count: 100, total_pages: 2 } }, now, usageInfo())).toThrow("USAGE_DATA_TRUNCATED");
    });
    it("rejects implausibly future charge periods", () => {
        expect(() => estimateUsage(usage(0, "2026-10-28T12:00:00Z"), now, usageInfo())).toThrow("USAGE_PERIOD_INVALID");
    });
});

describe("monitor state transitions and bounded failures", () => {
    it.each([
        { cost: 4.99, mode: "normal", reason: "within_budget" },
        { cost: 5, mode: "normal", reason: "budget_warning" },
        { cost: 10, mode: "restricted", reason: "budget_restricted" },
        { cost: 13, mode: "maintenance", reason: "budget_stop" },
    ])("applies the total-budget threshold for usage cost $cost", async ({ cost, mode, reason }) => {
        const f = fixture(cost);
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode, reason, estimatedUsd: cost + 5 });
        expect(f.info).toHaveBeenCalledTimes(1);
        expect(f.data).toHaveBeenCalledTimes(1);
        expect(f.send).not.toHaveBeenCalled();
    });
    it("never automatically recovers an existing restricted or maintenance state", () => {
        for (const mode of ["restricted", "maintenance"] as const) {
            expect(nextBudgetState(budget(mode), { estimatedUsd: 5, coverage: [] }, now)).toMatchObject({ mode, reason: "manual_recovery_required" });
            expect(nextBudgetState(budget(mode), null, now).mode).toBe(mode);
        }
    });
    it.each([403, 429, 503])("does not retry an HTTP %s coverage failure or treat it as zero", async (status) => {
        const f = fixture(0);
        f.info.mockImplementation(async () => new Response("Unavailable", { status }));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
        expect(result.estimatedUsd).toBeUndefined();
        expect(f.fetcher).toHaveBeenCalledTimes(1);
        expect(f.data).not.toHaveBeenCalled();
        expect(JSON.parse(f.state.get("budget:state")!)).toMatchObject({ mode: "restricted" });
    });
    it("bounds a costs request failure to one request after one successful metadata request", async () => {
        const f = fixture(0);
        f.data.mockImplementation(async () => new Response("Forbidden", { status: 403 }));
        expect((await runMonitor(f.env)).mode).toBe("restricted");
        expect(f.fetcher).toHaveBeenCalledTimes(2);
    });
    it.each(["ChargeDescription", "PricingUnit"] as const)("restricts rather than using an incomplete %s to authorize normal operation", async (field) => {
        const f = fixture(0);
        const data = usage(0);
        data.result[0][field] = "";
        f.data.mockImplementation(async () => Response.json(data));
        expect(await runMonitor(f.env)).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
        expect(f.fetcher).toHaveBeenCalledTimes(2);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it.each(["timeout", "invalid-json", "declared-oversize", "streamed-oversize"])("fails closed without retry for %s", async (failure) => {
        const f = fixture(0);
        f.info.mockImplementation(async () => {
            if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
            if (failure === "invalid-json") return new Response("not JSON");
            if (failure === "declared-oversize") return new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } });
            return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
        });
        expect((await runMonitor(f.env)).mode).toBe("restricted");
        expect(f.fetcher).toHaveBeenCalledTimes(1);
        const init = f.fetcher.mock.calls[0][1];
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.redirect).toBe("error");
    });
    it("sends only quota-approved alerts with the reserved operational limits", async () => {
        const f = fixture(5);
        f.env.ALERT_EMAIL = "ops@example.com";
        await runMonitor(f.env);
        expect(f.send).toHaveBeenCalledTimes(1);
        const request = f.quotaFetch.mock.calls[0][0];
        expect(await request.json()).toMatchObject({ limits: [
            { limit: 1, windowSeconds: 86400 }, { key: "alerts:day", limit: 6 }, { key: "alerts:month", limit: 40, period: "month" },
        ] });
        f.quotaFetch.mockImplementation(async () => Response.json({ allowed: false, retryAfter: 60 }, { status: 429 }));
        await runMonitor(f.env);
        expect(f.send).toHaveBeenCalledTimes(1);
    });
    it("retains the protective mode when quota or mail delivery is unavailable", async () => {
        const f = fixture(10);
        f.env.ALERT_EMAIL = "ops@example.com";
        f.quotaFetch.mockImplementation(async () => { throw new Error("DO unavailable"); });
        expect((await runMonitor(f.env)).mode).toBe("restricted");
        expect(f.send).not.toHaveBeenCalled();
        f.quotaFetch.mockImplementation(async () => Response.json({ allowed: true }));
        f.send.mockImplementation(async () => { throw new Error("Delivery failed"); });
        expect((await runMonitor(f.env)).mode).toBe("restricted");
    });
    it.each(["read-failure", "malformed-state", "write-failure"])("still activates both edge stops on KV %s", async (failure) => {
        const f = fixture(0);
        if (failure === "read-failure") f.get.mockRejectedValue(new Error("KV unavailable"));
        if (failure === "malformed-state") f.state.set("budget:state", JSON.stringify({ mode: "normal" }));
        if (failure === "write-failure") f.put.mockRejectedValue(new Error("KV unavailable"));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "maintenance", reason: "budget_state_unavailable", edgeBlocked: true, edgeDynamicBlocked: true, edgeMediaBlocked: true });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
        if (failure !== "write-failure") expect(f.info).not.toHaveBeenCalled();
    });
});

describe("emergency edge stops", () => {
    it("enables only the two preconfigured rules and verifies the active entry point", async () => {
        const f = fixture();
        expect((await runMonitor(f.env)).edgeBlocked).toBe(true);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
        const mutations = f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
        expect(mutations).toHaveLength(2);
        for (const [, init] of mutations) {
            expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-rule-token");
        }
        expect(JSON.parse(f.state.get("budget:state")!)).toMatchObject({ edgeBlocked: true });
    });
    it("does not mutate already enabled rules", async () => {
        const f = fixture();
        f.rules.forEach((rule) => { rule.enabled = true; });
        expect((await runMonitor(f.env)).edgeBlocked).toBe(true);
        expect(f.edgePatch).not.toHaveBeenCalled();
        expect(f.edgeRead).toHaveBeenCalledTimes(1);
    });
    it.each([
        { field: "phase", value: "http_request_firewall_managed" },
        { field: "kind", value: "custom" },
        { field: "id", value: "f".repeat(32) },
    ])("rejects an entry point with the wrong $field", async ({ field, value }) => {
        const f = fixture();
        f.edgeRead.mockImplementation(async () => Response.json({ success: true, result: { ...f.document().result, [field]: value } }));
        expect((await runMonitor(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it.each(["expression", "action"])("does not change a dynamic rule with a mismatched %s but still stops media", async (field) => {
        const f = fixture();
        if (field === "expression") f.rules[0].expression = "true";
        else f.rules[0].action = "managed_challenge";
        expect(await runMonitor(f.env)).toMatchObject({ edgeBlocked: false, edgeDynamicBlocked: false, edgeMediaBlocked: true });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([mediaId]);
    });
    it("does not claim effectiveness behind an enabled skip rule", async () => {
        const f = fixture();
        f.rules.unshift({ id: "f".repeat(32), action: "skip", expression: "true", enabled: true });
        expect((await runMonitor(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
        f.rules[0].enabled = false;
        expect((await runMonitor(f.env)).edgeBlocked).toBe(true);
    });
    it("rejects duplicate rule identifiers", async () => {
        const f = fixture();
        f.rules.push({ ...f.rules[0] });
        expect((await runMonitor(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it("attempts media even when the dynamic rule update fails", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async (id) => {
            if (id === dynamicId) throw new Error("Rules API unavailable");
            f.rules[1].enabled = true;
            return Response.json({ success: true });
        });
        expect(await runMonitor(f.env)).toMatchObject({ edgeDynamicBlocked: false, edgeMediaBlocked: true, edgeBlocked: false });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
    });
    it("checks readback after an uncertain mutation without retrying the mutation", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async (id) => {
            f.rules.find((rule) => rule.id === id)!.enabled = true;
            throw new DOMException("Response lost", "TimeoutError");
        });
        expect((await runMonitor(f.env)).edgeBlocked).toBe(true);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
    });
    it("does not treat successful mutation responses as effective blocks", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async () => Response.json({ success: true }));
        expect((await runMonitor(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });
    it("keeps maintenance active when the final readback fails", async () => {
        const f = fixture();
        f.edgeRead.mockImplementationOnce(async () => Response.json(f.document())).mockImplementationOnce(async () => { throw new Error("Readback unavailable"); });
        expect(await runMonitor(f.env)).toMatchObject({ mode: "maintenance", edgeBlocked: false });
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });
    it.each(["token", "zone", "ruleset", "duplicate-ids"])("does not mutate rules with missing or invalid %s configuration", async (failure) => {
        const f = fixture();
        if (failure === "token") f.env.CF_API_TOKEN = undefined;
        if (failure === "zone") f.env.CF_ZONE_ID = "0".repeat(32);
        if (failure === "ruleset") f.env.EDGE_RULESET_ID = "";
        if (failure === "duplicate-ids") f.env.EDGE_MEDIA_RULE_ID = dynamicId;
        expect(await runMonitor(f.env)).toMatchObject({ mode: "maintenance", edgeBlocked: false });
        expect(f.edgeRead).not.toHaveBeenCalled();
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it.each(["dynamic", "media"] as const)("still attempts the other stop when the %s rule ID is missing", async (missing) => {
        const f = fixture();
        if (missing === "dynamic") f.env.EDGE_RULE_ID = "";
        else f.env.EDGE_MEDIA_RULE_ID = "";
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({
            mode: "maintenance", edgeBlocked: false,
            edgeDynamicBlocked: missing !== "dynamic", edgeMediaBlocked: missing !== "media",
        });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([missing === "dynamic" ? mediaId : dynamicId]);
    });
    it.each(["dynamic", "media"] as const)("still attempts the other stop when the %s origin is invalid", async (invalid) => {
        const f = fixture();
        if (invalid === "dynamic") f.env.ORIGIN = "http://store.vrclearn.com";
        else f.env.MEDIA_ORIGIN = "https://store-media.vrclearn.com/path";
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({
            mode: "maintenance", edgeBlocked: false,
            edgeDynamicBlocked: invalid !== "dynamic", edgeMediaBlocked: invalid !== "media",
        });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([invalid === "dynamic" ? mediaId : dynamicId]);
    });
    it("keeps the deployment manifest synchronized with both runtime expressions", () => {
        const policies = JSON.parse(readFileSync("deployment/edge-policies.json", "utf8"));
        expect(policies.emergencyDynamicStop).toMatchObject({ enabled: false, action: "block", expression: dynamicBlockExpression("https://store.vrclearn.com") });
        expect(policies.emergencyMediaStop).toMatchObject({ enabled: false, action: "block", expression: mediaBlockExpression("https://store-media.vrclearn.com") });
    });
    it.each(["http://store.vrclearn.com", "https://store.vrclearn.com/path", "https://store.vrclearn.com/"])("rejects an ambiguous origin %s", (origin) => {
        expect(() => dynamicBlockExpression(origin)).toThrow("INVALID_ORIGIN");
        expect(() => mediaBlockExpression(origin)).toThrow("INVALID_ORIGIN");
    });
});
