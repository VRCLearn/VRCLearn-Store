import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingUsageWindow, dynamicBlockExpression, estimateUsage, mediaBlockExpression, nextBudgetState, runMonitor, activateEdgeStops, sharedDynamicBlockExpression, sharedMediaBlockExpression, type BudgetState } from "../control/monitor";
import type { ControlEnv } from "../control/env";

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
interface Rule { id: string; action: string; expression: string; enabled: boolean; description?: string; ref?: string }
interface RuleDefinition { action: string; expression: string; enabled?: boolean; description?: string; ref?: string }
function fixture(cost = 13) {
    const state = new Map<string, string>([["budget:state", JSON.stringify(budget("normal"))], ["budget:delivery", JSON.stringify(budget("normal"))]]);
    const get = vi.fn(async (key: string) => {
        const value = state.get(key);
        return value === undefined ? null : JSON.parse(value) as unknown;
    });
    const put = vi.fn(async (key: string, value: string) => { state.set(key, value); });
    const quotaFetch = vi.fn(async (_request: Request) => Response.json({ allowed: true }));
    const send = vi.fn(async (_message: unknown) => ({ messageId: "test-alert" }));
    const productionState = new Map<string, string>();
    const testState = new Map<string, string>();
    function replica(values: Map<string, string>) { return Object.assign({} as KVNamespace, { get: vi.fn(async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null), put: vi.fn(async (key: string, value: string) => { values.set(key, value); }) }); }
    const env: ControlEnv = Object.assign({} as ControlEnv, {
        CF_MONITOR_TOKEN: "test-monitor-token", CF_API_TOKEN: "test-rule-token", CF_ACCOUNT_ID: accountId, CF_ZONE_ID: zoneId,
        EDGE_RULESET_ID: rulesetId, PRODUCTION_EDGE_RULE_ID: dynamicId, PRODUCTION_EDGE_MEDIA_RULE_ID: mediaId,
        TEST_EDGE_RULE_ID: dynamicId, TEST_EDGE_MEDIA_RULE_ID: mediaId,
        PRODUCTION_ORIGIN: "https://store.vrclearn.com", PRODUCTION_MEDIA_ORIGIN: "https://store-media.vrclearn.com", ENVIRONMENT: "production",
        TEST_ORIGIN: "https://test-store.vrclearn.com", TEST_MEDIA_ORIGIN: "https://test-store-media.vrclearn.com",
        ALERT_EMAIL: "", EMAIL_FROM: "noreply@vrclearn.com",
        STATE: Object.assign({} as KVNamespace, { get, put }),
        PRODUCTION_STATE: replica(productionState), TEST_STATE: replica(testState),
        QUOTA: Object.assign({} as ControlEnv["QUOTA"], { getByName: () => ({ fetch: quotaFetch }) }),
        EMAIL: Object.assign({} as SendEmail, { send }),
    });
    const rules: Rule[] = [
        { id: dynamicId, action: "block", expression: dynamicBlockExpression(env.PRODUCTION_ORIGIN), enabled: false, description: "Store dynamic emergency stop", ref: "store_dynamic_stop" },
        { id: mediaId, action: "block", expression: mediaBlockExpression(env.PRODUCTION_MEDIA_ORIGIN), enabled: false, description: "Store media emergency stop", ref: "store_media_stop" },
    ];
    const document = () => ({ success: true, result: { id: rulesetId, kind: "zone", phase: "http_request_firewall_custom", rules } });
    const info = vi.fn(async () => Response.json(usageInfo()));
    const data = vi.fn(async () => Response.json(usage(cost)));
    const edgeRead = vi.fn(async () => Response.json(document()));
    const edgePatch = vi.fn(async (id: string, body: RuleDefinition) => {
        const rule = rules.find((entry) => entry.id === id);
        if (!rule) throw new Error("Unexpected rule mutation");
        rule.action = body.action;
        rule.expression = body.expression;
        rule.enabled = body.enabled ?? true;
        if (body.description === undefined) delete rule.description;
        else rule.description = body.description;
        if (body.ref === undefined) delete rule.ref;
        else rule.ref = body.ref;
        return Response.json({ success: true });
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.redirect === "error") throw new TypeError("Workers does not implement redirect:error");
        const url = String(input);
        if (url === `${billingBase}/info`) return info();
        if (url.startsWith(`${billingBase}?`)) return data();
        if (url === entrypoint && (init?.method ?? "GET") === "GET") return edgeRead();
        if (init?.method === "PATCH" && url.startsWith(`${rulesBase}/${rulesetId}/rules/`)) {
            const body = JSON.parse(String(init.body)) as RuleDefinition;
            if (!body.action) return Response.json({ success: false, errors: [{ code: 20015, message: "action required to create or update rule" }] }, { status: 400 });
            if (!body.expression) return Response.json({ success: false, errors: [{ message: "expression required to update rule definition" }] }, { status: 400 });
            return edgePatch(url.split("/").at(-1)!, body);
        }
        throw new Error(`Unexpected external request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    return { env, state, productionState, testState, get, put, quotaFetch, send, rules, document, info, data, edgeRead, edgePatch, fetcher };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("billing period and source validation", () => {
    it("queries the current anchor through the next UTC day rather than V1's default multi-cycle range", () => {
        expect(billingUsageWindow(usageInfo("2025-08-26T00:00:00Z"), now).toString()).toBe("from=2026-10-26&to=2026-10-27");
        expect(billingUsageWindow(usageInfo("2025-08-26T00:00:00Z"), Date.parse("2026-11-01T00:30:00+09:00")).toString()).toBe("from=2026-10-26&to=2026-11-01");
    });
    it("includes all current subscription anchors in one bounded query", () => {
        const info = usageInfo("2025-08-26T00:00:00Z");
        info.result.subscriptions.push({ ...info.result.subscriptions[0], id: "subscription-two", billing_cycle_anchor_timestamp: "2025-08-09T06:00:00Z" });
        expect(billingUsageWindow(info, now).toString()).toBe("from=2026-10-09&to=2026-10-27");
    });
    it("clamps the query's month-end anchor and advances the UTC year", () => {
        const info = usageInfo("2025-01-31T06:00:00Z");
        expect(billingUsageWindow(info, Date.parse("2028-03-01T12:00:00Z")).toString()).toBe("from=2028-02-29&to=2028-03-02");
        expect(billingUsageWindow(info, Date.parse("2027-12-31T12:00:00Z")).toString()).toBe("from=2027-12-31&to=2028-01-01");
    });
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
        { ...usageInfo(), errors: [{ message: "Coverage unavailable" }] },
    ])("rejects invalid or unverified coverage metadata %j", (info) => {
        expect(() => estimateUsage(usage(0), now, info)).toThrow("USAGE_INFO_INVALID");
    });
    it.each([null, { success: false }, { success: true, result: [] }])("rejects an absent costs feed %j", (data) => {
        expect(() => estimateUsage(data, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
    });
    it("accepts a covered account's complete current-period feed without inventing absent product rows", () => {
        const data = usage(1);
        data.result = data.result.filter((row) => row.ServiceName !== "Workers Logs");
        const estimate = estimateUsage(data, now, usageInfo());
        expect(estimate).toMatchObject({ estimatedUsd: 6, coverageBasis: "provider-account" });
        expect(estimate.coverage).not.toContain("logs");
        expect(nextBudgetState(null, estimate, now)).toMatchObject({ mode: "normal", coverageBasis: "provider-account" });
    });
    it("includes unknown service costs while reporting only recognized observed families", () => {
        const data = usage(1);
        data.result.push({ ...data.result[0], ServiceName: "Another metered product", ServiceFamilyName: "Another product", ChargeDescription: "Another metered product requests", CumulatedContractedCost: 14 });
        const estimate = estimateUsage(data, now, usageInfo());
        expect(estimate.estimatedUsd).toBe(20);
        expect(nextBudgetState(null, estimate, now).mode).toBe("maintenance");
        expect(estimate.coverage).not.toContain("Another product");
    });
    it("rejects currency mismatches, invalid costs and truncated pages", () => {
        const euro = usage(1); euro.result[0].BillingCurrency = "EUR";
        expect(() => estimateUsage(euro, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
        for (const cost of [-1, Infinity, NaN]) expect(() => estimateUsage(usage(cost), now, usageInfo())).toThrow("USAGE_DATA_INVALID");
        expect(() => estimateUsage({ ...usage(1), result_info: { total_count: 100, total_pages: 2 } }, now, usageInfo())).toThrow("USAGE_DATA_TRUNCATED");
    });
    it.each([null, {}, { total_count: 7, page: 2 }, { total_count: 7, count: 6 }, { total_count: 8 }, { total_count: 7, total_pages: 2 }])("rejects incomplete or inconsistent response pagination %j", (resultInfo) => {
        expect(() => estimateUsage({ ...usage(0), result_info: resultInfo }, now, usageInfo())).toThrow("USAGE_DATA_TRUNCATED");
    });
    it.each([{ errors: [{ message: "Incomplete response" }] }, { errors: "invalid-errors" }])("rejects a contradictory success response with errors $errors", ({ errors }) => {
        expect(() => estimateUsage({ ...usage(0), errors }, now, usageInfo())).toThrow("USAGE_DATA_INVALID");
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
        expect(f.fetcher.mock.calls[1][0]).toBe(`${billingBase}?from=2026-10-01&to=2026-10-27`);
        expect(f.send).not.toHaveBeenCalled();
    });
    it("never automatically recovers an existing restricted or maintenance state", () => {
        for (const mode of ["restricted", "maintenance"] as const) {
            expect(nextBudgetState(budget(mode), { estimatedUsd: 5, coverage: [], coverageBasis: "provider-account", sourceUpdatedAt: currentEnd }, now)).toMatchObject({ mode, reason: "manual_recovery_required" });
            expect(nextBudgetState(budget(mode), null, now).mode).toBe(mode);
        }
    });
    it.each([403, 429, 503])("does not retry an HTTP %s coverage failure or treat it as zero", async (status) => {
        const f = fixture(0);
        f.info.mockImplementation(async () => new Response("Unavailable", { status }));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
        expect(result.estimatedUsd).toBe(5);
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
    it.each(["info", "data"] as const)("fails closed without following a redirected %s source request", async (source) => {
        const f = fixture(0);
        const destination = "https://untrusted.example/collect";
        f[source].mockImplementation(async () => Response.redirect(destination, 302));
        expect(await runMonitor(f.env)).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
        expect(f.fetcher).toHaveBeenCalledTimes(source === "info" ? 1 : 2);
        for (const [input, init] of f.fetcher.mock.calls) {
            expect(new URL(String(input)).origin).toBe("https://api.cloudflare.com");
            expect(init?.redirect).toBe("manual");
        }
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it("stops before requesting costs when account coverage metadata is unverified", async () => {
        const f = fixture(0);
        const info = usageInfo();
        info.result.covered = false;
        f.info.mockImplementation(async () => Response.json(info));
        expect(await runMonitor(f.env)).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable" });
        expect(f.fetcher).toHaveBeenCalledTimes(1);
        expect(f.data).not.toHaveBeenCalled();
    });
    it("persists the account coverage basis without claiming a Logs row was observed", async () => {
        const f = fixture(0);
        const data = usage(0);
        data.result = data.result.filter((row) => row.ServiceName !== "Workers Logs");
        f.data.mockImplementation(async () => Response.json(data));
        expect(await runMonitor(f.env)).toMatchObject({ mode: "normal", estimatedUsd: 5, coverageBasis: "provider-account" });
        const stored = JSON.parse(f.state.get("budget:state")!);
        expect(stored.coverage).not.toContain("logs");
        expect(stored.coverageBasis).toBe("provider-account");
        f.info.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
        const failed = await runMonitor(f.env);
        expect(failed).toMatchObject({ mode: "restricted", reason: "usage_source_unavailable", estimatedUsd: 5, coverage: [] });
        expect(failed.coverageBasis).toBeUndefined();
    });
    it("rejects an unrecognized persisted coverage basis as malformed state", async () => {
        const f = fixture(0);
        f.state.set("budget:state", JSON.stringify({ ...budget("normal"), coverageBasis: "invented-product-zero" }));
        expect(await runMonitor(f.env)).toMatchObject({ mode: "maintenance", reason: "budget_state_unavailable" });
        expect(f.info).not.toHaveBeenCalled();
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
        expect(init?.redirect).toBe("manual");
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

function stopTargets(env: ControlEnv, production: boolean, test: boolean) {
    return [
        { name: "production" as const, origin: env.PRODUCTION_ORIGIN, mediaOrigin: env.PRODUCTION_MEDIA_ORIGIN, dynamicRuleId: env.PRODUCTION_EDGE_RULE_ID, mediaRuleId: env.PRODUCTION_EDGE_MEDIA_RULE_ID, blocked: production },
        { name: "test" as const, origin: env.TEST_ORIGIN, mediaOrigin: env.TEST_MEDIA_ORIGIN, dynamicRuleId: env.TEST_EDGE_RULE_ID, mediaRuleId: env.TEST_EDGE_MEDIA_RULE_ID, blocked: test },
    ];
}
async function stop(env: ControlEnv) {
    const stopped = await activateEdgeStops(env, stopTargets(env, true, false));
    return { edgeBlocked: stopped.targets.production.dynamic && stopped.targets.production.media, edgeDynamicBlocked: stopped.targets.production.dynamic, edgeMediaBlocked: stopped.targets.production.media };
}
describe("isolated account budget delivery", () => {
    it("reserves alert quota from a separate global object rather than the account-monitor coordinator", async () => {
        const f = fixture(5);
        f.env.ALERT_EMAIL = "owner@example.com";
        const names = vi.spyOn(f.env.QUOTA, "getByName");
        await runMonitor(f.env);
        expect(names).toHaveBeenCalledExactlyOnceWith("global");
        expect(f.quotaFetch).toHaveBeenCalledTimes(1);
        expect(f.send).toHaveBeenCalledTimes(1);
    });

    it.each(["budget:state", "budget:delivery"])("requires explicit authority initialization when %s is missing", async (key) => {
        const f = fixture(0);
        f.state.delete(key);
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "maintenance", reason: "budget_state_unavailable", edgeBlocked: true });
        expect(f.info).not.toHaveBeenCalled();
        for (const name of ["production", "test"] as const) expect(result.environments?.[name].mode).toBe("maintenance");
    });

    it("retains a transferred account restriction even when the current source is back below threshold", async () => {
        const f = fixture(0);
        for (const key of ["budget:state", "budget:delivery"]) f.state.set(key, JSON.stringify(budget("restricted", 15)));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "restricted", reason: "manual_recovery_required", estimatedUsd: 5 });
        for (const values of [f.productionState, f.testState]) expect(JSON.parse(values.get("budget:state")!).mode).toBe("restricted");
    });

    it("closes both environments after an interrupted DO run even if the prior KV snapshot looks normal", async () => {
        const f = fixture(0);
        const result = await runMonitor(f.env, { failClosed: true });
        expect(result).toMatchObject({ mode: "maintenance", reason: "budget_state_unavailable", edgeBlocked: true });
        expect(f.info).not.toHaveBeenCalled();
    });

    it("reads account costs once and publishes independent gates without sharing environment receipts", async () => {
        const f = fixture(0);
        const result = await runMonitor(f.env);
        expect(result.mode).toBe("normal");
        expect(result.environments).toEqual({
            production: { mode: "normal", reason: "within_budget", delivered: true, edgeDynamicBlocked: false, edgeMediaBlocked: false },
            test: { mode: "normal", reason: "within_budget", delivered: true, edgeDynamicBlocked: false, edgeMediaBlocked: false },
        });
        expect(f.info).toHaveBeenCalledTimes(1);
        expect(f.data).toHaveBeenCalledTimes(1);
        expect(f.edgePatch).not.toHaveBeenCalled();
        expect(f.put.mock.calls.map(([key]) => key)).toEqual(["budget:state", "budget:delivery"]);
        for (const values of [f.productionState, f.testState]) {
            const value = JSON.parse(values.get("budget:state")!);
            expect(value).toMatchObject({ mode: "normal", estimatedUsd: 5 });
            expect(value).not.toHaveProperty("environments");
        }
        expect(JSON.parse(f.state.get("budget:delivery")!).environments).toEqual(result.environments);
    });

    it.each(["read", "write"])("blocks and alerts only test when its replica %s fails", async (failure) => {
        const f = fixture(0);
        f.env.ALERT_EMAIL = "owner@example.com";
        if (failure === "read") vi.spyOn(f.env.TEST_STATE, "get").mockRejectedValue(new Error("Test KV unavailable"));
        else vi.spyOn(f.env.TEST_STATE, "put").mockRejectedValue(new Error("Test KV unavailable"));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "normal", reason: "within_budget", edgeBlocked: false });
        expect(result.environments?.production).toMatchObject({ mode: "normal", delivered: true, edgeDynamicBlocked: false, edgeMediaBlocked: false });
        expect(result.environments?.test).toMatchObject({ mode: "maintenance", reason: "replica_state_unavailable", delivered: failure === "read", edgeDynamicBlocked: true, edgeMediaBlocked: true });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([f.env.TEST_EDGE_RULE_ID, f.env.TEST_EDGE_MEDIA_RULE_ID]);
        expect(JSON.parse(f.productionState.get("budget:state")!).mode).toBe("normal");
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.send.mock.calls[0][0]).toMatchObject({ subject: "VRCLearn Store: normal (environment_delivery_failed)" });
    });

    it("retains a test-only maintenance latch after KV recovers until manual restoration", async () => {
        const f = fixture(0);
        vi.spyOn(f.env.TEST_STATE, "put").mockRejectedValueOnce(new Error("Test KV unavailable"));
        await runMonitor(f.env);
        vi.setSystemTime(now + 900_000);
        const result = await runMonitor(f.env);
        expect(result.mode).toBe("normal");
        expect(result.environments?.production.mode).toBe("normal");
        expect(result.environments?.test).toMatchObject({ mode: "maintenance", reason: "manual_recovery_required", delivered: true, edgeDynamicBlocked: true, edgeMediaBlocked: true });
        expect(f.rules.filter((rule) => rule.enabled).map((rule) => rule.id)).toEqual([f.env.TEST_EDGE_RULE_ID, f.env.TEST_EDGE_MEDIA_RULE_ID]);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });

    it("does not promote a test-controlled maintenance state into the account or production mode", async () => {
        const f = fixture(0);
        f.testState.set("budget:state", JSON.stringify({ ...budget("maintenance"), reason: "budget_state_unavailable" }));
        const result = await runMonitor(f.env);
        expect(result.mode).toBe("normal");
        expect(result.environments?.production.mode).toBe("normal");
        expect(result.environments?.test.mode).toBe("maintenance");
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([f.env.TEST_EDGE_RULE_ID, f.env.TEST_EDGE_MEDIA_RULE_ID]);
    });

    it("does not mutate either shared rule when their entrypoint cannot be verified", async () => {
        const f = fixture(13);
        f.edgeRead.mockRejectedValueOnce(new Error("Entrypoint read unavailable"));
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "maintenance", reason: "budget_stop", edgeBlocked: false });
        for (const name of ["production", "test"] as const) expect(result.environments?.[name]).toMatchObject({ mode: "maintenance", delivered: true, edgeDynamicBlocked: false, edgeMediaBlocked: false });
        expect(f.edgePatch).not.toHaveBeenCalled();
        expect(f.edgeRead).toHaveBeenCalledTimes(1);
    });

    it("treats unreadable authority receipts as an account-wide failure", async () => {
        const f = fixture(0);
        f.state.set("budget:state", JSON.stringify(budget("normal")));
        f.state.set("budget:delivery", "{}");
        const result = await runMonitor(f.env);
        expect(result).toMatchObject({ mode: "maintenance", reason: "budget_state_unavailable", edgeBlocked: true });
        expect(f.info).not.toHaveBeenCalled();
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
    });
});

describe("emergency edge stops", () => {
    it("never narrows an existing global emergency stop during a later test-only check", async () => {
        const f = fixture();
        f.rules[0].expression = sharedDynamicBlockExpression([f.env.PRODUCTION_ORIGIN, f.env.TEST_ORIGIN]);
        f.rules[1].expression = sharedMediaBlockExpression([f.env.PRODUCTION_MEDIA_ORIGIN, f.env.TEST_MEDIA_ORIGIN]);
        for (const rule of f.rules) rule.enabled = true;
        const original = structuredClone(f.rules);
        const result = await activateEdgeStops(f.env, stopTargets(f.env, false, true));
        expect(f.rules).toEqual(original);
        expect(f.edgePatch).not.toHaveBeenCalled();
        expect(result.targets.test).toEqual({ dynamic: true, media: true });
    });

    it("combines both stopped environments before patching each shared rule once", async () => {
        const f = fixture(13);
        const result = await runMonitor(f.env);
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
        expect(f.rules).toMatchObject([
            { enabled: true, expression: sharedDynamicBlockExpression([f.env.PRODUCTION_ORIGIN, f.env.TEST_ORIGIN]) },
            { enabled: true, expression: sharedMediaBlockExpression([f.env.PRODUCTION_MEDIA_ORIGIN, f.env.TEST_MEDIA_ORIGIN]) },
        ]);
        expect(result).toMatchObject({ mode: "maintenance", edgeBlocked: true });
        for (const name of ["production", "test"] as const) expect(result.environments?.[name]).toMatchObject({ edgeDynamicBlocked: true, edgeMediaBlocked: true });
        vi.setSystemTime(now + 900_000);
        await runMonitor(f.env);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
        expect(f.edgeRead).toHaveBeenCalledTimes(3);
    });

    it("uses only test hosts for a local test fault and expands atomically for an account stop", async () => {
        const f = fixture(0);
        vi.spyOn(f.env.TEST_STATE, "get").mockRejectedValueOnce(new Error("Test replica unavailable"));
        await runMonitor(f.env);
        expect(f.rules[0]).toMatchObject({ enabled: true, expression: dynamicBlockExpression(f.env.TEST_ORIGIN) });
        expect(f.rules[1]).toMatchObject({ enabled: true, expression: mediaBlockExpression(f.env.TEST_MEDIA_ORIGIN) });
        f.data.mockImplementation(async () => Response.json(usage(13)));
        vi.setSystemTime(now + 900_000);
        const result = await runMonitor(f.env);
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId, dynamicId, mediaId]);
        expect(f.rules[0].expression).toBe(sharedDynamicBlockExpression([f.env.PRODUCTION_ORIGIN, f.env.TEST_ORIGIN]));
        expect(f.rules[1].expression).toBe(sharedMediaBlockExpression([f.env.PRODUCTION_MEDIA_ORIGIN, f.env.TEST_MEDIA_ORIGIN]));
        expect(result.edgeBlocked).toBe(true);
    });

    it("reports per-environment partial coverage when one shared update fails", async () => {
        const f = fixture();
        const patch = f.edgePatch.getMockImplementation()!;
        f.edgePatch.mockImplementation(async (id, body) => id === dynamicId ? Response.json({ success: false }, { status: 503 }) : patch(id, body));
        const result = await activateEdgeStops(f.env, stopTargets(f.env, true, true));
        expect(result).toEqual({
            targets: { production: { dynamic: false, media: true }, test: { dynamic: false, media: true } },
            verified: { dynamic: false, media: true },
        });
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
    });

    it("requires exact combined scope on readback instead of trusting a partial old stop", async () => {
        const f = fixture();
        for (const rule of f.rules) rule.enabled = true;
        f.edgePatch.mockImplementation(async () => Response.json({ success: true }));
        const result = await activateEdgeStops(f.env, stopTargets(f.env, true, true));
        expect(result).toEqual({
            targets: { production: { dynamic: false, media: false }, test: { dynamic: false, media: false } },
            verified: { dynamic: false, media: false },
        });
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });

    it("keeps the full explicit scope when manually disabling shared stops and verifies the disabled definitions", async () => {
        const f = fixture();
        f.rules[0].expression = sharedDynamicBlockExpression([f.env.PRODUCTION_ORIGIN, f.env.TEST_ORIGIN]);
        f.rules[1].expression = sharedMediaBlockExpression([f.env.PRODUCTION_MEDIA_ORIGIN, f.env.TEST_MEDIA_ORIGIN]);
        for (const rule of f.rules) rule.enabled = true;
        const before = structuredClone(f.rules);
        const result = await activateEdgeStops(f.env, stopTargets(f.env, false, false), { allowRecovery: true });
        expect(result).toEqual({
            targets: { production: { dynamic: false, media: false }, test: { dynamic: false, media: false } },
            verified: { dynamic: true, media: true },
        });
        expect(f.rules).toEqual(before.map((rule) => ({ ...rule, enabled: false })));
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
    });

    it("narrows a shared stop only with explicit manual recovery and leaves the other environment blocked", async () => {
        const f = fixture();
        f.rules[0].expression = sharedDynamicBlockExpression([f.env.PRODUCTION_ORIGIN, f.env.TEST_ORIGIN]);
        f.rules[1].expression = sharedMediaBlockExpression([f.env.PRODUCTION_MEDIA_ORIGIN, f.env.TEST_MEDIA_ORIGIN]);
        for (const rule of f.rules) rule.enabled = true;
        const result = await activateEdgeStops(f.env, stopTargets(f.env, false, true), { allowRecovery: true });
        expect(f.rules[0]).toMatchObject({ enabled: true, expression: dynamicBlockExpression(f.env.TEST_ORIGIN) });
        expect(f.rules[1]).toMatchObject({ enabled: true, expression: mediaBlockExpression(f.env.TEST_MEDIA_ORIGIN) });
        expect(result).toEqual({ targets: { production: { dynamic: false, media: false }, test: { dynamic: true, media: true } }, verified: { dynamic: true, media: true } });
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });

    it("enables only the two preconfigured rules and verifies the active entry point", async () => {
        const f = fixture();
        const original = structuredClone(f.rules);
        expect((await stop(f.env)).edgeBlocked).toBe(true);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
        const mutations = f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
        expect(mutations).toHaveLength(2);
        for (const [input, init] of mutations) {
            const id = String(input).split("/").at(-1);
            const rule = original.find((entry) => entry.id === id)!;
            expect(JSON.parse(String(init?.body))).toEqual({ action: "block", enabled: true, expression: rule.expression, description: rule.description, ref: rule.ref });
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-rule-token");
        }
        expect(f.rules).toEqual(original.map((rule, index) => ({ ...rule, enabled: index < 2 ? true : rule.enabled })));
        for (const [input, init] of f.fetcher.mock.calls) {
            expect(new URL(String(input)).origin).toBe("https://api.cloudflare.com");
            expect(init?.redirect).toBe("manual");
        }

    });
    it.each(["read", "write"] as const)("does not follow a redirected WAF %s request or report an unverified stop", async (stage) => {
        const f = fixture();
        const destination = "https://untrusted.example/collect";
        if (stage === "read") f.edgeRead.mockImplementation(async () => Response.redirect(destination, 307));
        else f.edgePatch.mockImplementation(async () => Response.redirect(destination, 307));
        expect(await stop(f.env)).toMatchObject({ edgeBlocked: false });
        expect(f.fetcher).toHaveBeenCalledTimes(stage === "read" ? 1 : 4);
        for (const [input, init] of f.fetcher.mock.calls) {
            expect(new URL(String(input)).origin).toBe("https://api.cloudflare.com");
            expect(init?.redirect).toBe("manual");
        }
        if (stage === "read") expect(f.edgePatch).not.toHaveBeenCalled();
        else expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });
    it("preserves bare definitions without optional metadata and omits API-managed fields", async () => {
        const f = fixture();
        for (const rule of f.rules) {
            delete rule.description;
            delete rule.ref;
            Object.assign(rule, { version: "1", last_updated: "2026-10-26T00:00:00Z" });
        }
        expect((await stop(f.env)).edgeBlocked).toBe(true);
        for (const [id, body] of f.edgePatch.mock.calls) {
            expect(body).toEqual({ action: "block", enabled: true, expression: f.rules.find((rule) => rule.id === id)!.expression });
        }
    });
    it.each(["action_parameters", "logging", "ratelimit", "exposed_credential_check", "categories"])("does not replace a dedicated stop definition with unexpected %s settings", async (field) => {
        const f = fixture();
        Object.assign(f.rules[0], { [field]: {} });
        expect(await stop(f.env)).toMatchObject({ edgeBlocked: false, edgeDynamicBlocked: false, edgeMediaBlocked: true });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([mediaId]);
    });
    it.each(["description", "ref"])("rejects malformed %s metadata instead of dropping it", async (field) => {
        const f = fixture();
        Object.assign(f.rules[0], { [field]: { invalid: true } });
        expect((await stop(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it("does not mutate already enabled rules", async () => {
        const f = fixture();
        f.rules.forEach((rule) => { rule.enabled = true; });
        expect((await stop(f.env)).edgeBlocked).toBe(true);
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
        expect((await stop(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it.each(["expression", "action"])("does not change a dynamic rule with a mismatched %s but still stops media", async (field) => {
        const f = fixture();
        if (field === "expression") f.rules[0].expression = "true";
        else f.rules[0].action = "managed_challenge";
        expect(await stop(f.env)).toMatchObject({ edgeBlocked: false, edgeDynamicBlocked: false, edgeMediaBlocked: true });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([mediaId]);
    });
    it("does not claim effectiveness behind an enabled skip rule", async () => {
        const f = fixture();
        f.rules.unshift({ id: "f".repeat(32), action: "skip", expression: "true", enabled: true });
        expect((await stop(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
        f.rules[0].enabled = false;
        expect((await stop(f.env)).edgeBlocked).toBe(true);
    });
    it("rejects duplicate rule identifiers", async () => {
        const f = fixture();
        f.rules.push({ ...f.rules[0] });
        expect((await stop(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it("attempts media even when the dynamic rule update fails", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async (id) => {
            if (id === dynamicId) throw new Error("Rules API unavailable");
            f.rules[1].enabled = true;
            return Response.json({ success: true });
        });
        expect(await stop(f.env)).toMatchObject({ edgeDynamicBlocked: false, edgeMediaBlocked: true, edgeBlocked: false });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([dynamicId, mediaId]);
    });
    it("checks readback after an uncertain mutation without retrying the mutation", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async (id) => {
            f.rules.find((rule) => rule.id === id)!.enabled = true;
            throw new DOMException("Response lost", "TimeoutError");
        });
        expect((await stop(f.env)).edgeBlocked).toBe(true);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
        expect(f.edgeRead).toHaveBeenCalledTimes(2);
    });
    it("does not treat successful mutation responses as effective blocks", async () => {
        const f = fixture();
        f.edgePatch.mockImplementation(async () => Response.json({ success: true }));
        expect((await stop(f.env)).edgeBlocked).toBe(false);
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });
    it("keeps maintenance active when the final readback fails", async () => {
        const f = fixture();
        f.edgeRead.mockImplementationOnce(async () => Response.json(f.document())).mockImplementationOnce(async () => { throw new Error("Readback unavailable"); });
        expect(await stop(f.env)).toMatchObject({ edgeBlocked: false });
        expect(f.edgePatch).toHaveBeenCalledTimes(2);
    });
    it.each(["token", "zone", "ruleset", "duplicate-ids"])("does not mutate rules with missing or invalid %s configuration", async (failure) => {
        const f = fixture();
        if (failure === "token") Reflect.deleteProperty(f.env, "CF_API_TOKEN");
        if (failure === "zone") f.env.CF_ZONE_ID = "0".repeat(32);
        if (failure === "ruleset") f.env.EDGE_RULESET_ID = "";
        if (failure === "duplicate-ids") f.env.PRODUCTION_EDGE_MEDIA_RULE_ID = dynamicId;
        expect(await stop(f.env)).toMatchObject({ edgeBlocked: false });
        expect(f.edgeRead).not.toHaveBeenCalled();
        expect(f.edgePatch).not.toHaveBeenCalled();
    });
    it.each(["dynamic", "media"] as const)("still attempts the other stop when the %s rule ID is missing", async (missing) => {
        const f = fixture();
        if (missing === "dynamic") f.env.PRODUCTION_EDGE_RULE_ID = "";
        else f.env.PRODUCTION_EDGE_MEDIA_RULE_ID = "";
        const result = await stop(f.env);
        expect(result).toMatchObject({
            edgeBlocked: false,
            edgeDynamicBlocked: missing !== "dynamic", edgeMediaBlocked: missing !== "media",
        });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([missing === "dynamic" ? mediaId : dynamicId]);
    });
    it.each(["dynamic", "media"] as const)("still attempts the other stop when the %s origin is invalid", async (invalid) => {
        const f = fixture();
        if (invalid === "dynamic") f.env.PRODUCTION_ORIGIN = "http://store.vrclearn.com";
        else f.env.PRODUCTION_MEDIA_ORIGIN = "https://store-media.vrclearn.com/path";
        const result = await stop(f.env);
        expect(result).toMatchObject({
            edgeBlocked: false,
            edgeDynamicBlocked: invalid !== "dynamic", edgeMediaBlocked: invalid !== "media",
        });
        expect(f.edgePatch.mock.calls.map(([id]) => id)).toEqual([invalid === "dynamic" ? mediaId : dynamicId]);
    });
    it("keeps the deployment manifest synchronized with both runtime expressions", () => {
        const policies = JSON.parse(readFileSync("deployment/edge-policies.json", "utf8"));
        expect(policies.emergencyDynamicStop).toMatchObject({ enabled: false, action: "block", expression: sharedDynamicBlockExpression(["https://store.vrclearn.com", "https://test-store.vrclearn.com"]) });
        expect(policies.emergencyMediaStop).toMatchObject({ enabled: false, action: "block", expression: sharedMediaBlockExpression(["https://store-media.vrclearn.com", "https://test-store-media.vrclearn.com"]) });
    });
    it.each(["http://store.vrclearn.com", "https://store.vrclearn.com/path", "https://store.vrclearn.com/"])("rejects an ambiguous origin %s", (origin) => {
        expect(() => dynamicBlockExpression(origin)).toThrow("INVALID_ORIGIN");
        expect(() => mediaBlockExpression(origin)).toThrow("INVALID_ORIGIN");
    });
});
