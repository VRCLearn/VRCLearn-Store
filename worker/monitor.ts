import type { SupportEnv } from "./env";
import { reserve } from "./email";
import { readBounded } from "./http";
import { isBudgetMode, type BudgetMode } from "../edge/budget";

export type { BudgetMode } from "../edge/budget";
export interface BudgetState {
    mode: BudgetMode;
    updatedAt: string;
    reason: string;
    estimatedUsd?: number;
    source: "billable-usage";
    coverage: string[];
    sourceUpdatedAt?: string;
    edgeBlocked?: boolean;
    edgeDynamicBlocked?: boolean;
    edgeMediaBlocked?: boolean;
}
interface UsageRow {
    ServiceName: string;
    ServiceFamilyName?: string;
    BillingCurrency: string;
    CumulatedContractedCost: number;
    ChargePeriodEnd: string;
    BillingPeriodStart: string;
    SubscriptionId?: string;
    ZoneId?: string;
    PricingUnit: string;
    ChargeDescription: string;
    x_BillableMetricId?: string;
}
const RANK: Record<BudgetMode, number> = { normal: 0, restricted: 1, maintenance: 2 };
const REQUIRED_COVERAGE = ["workers", "pages", "d1", "r2", "durable-objects", "email", "logs", "kv"];
const MAX_SOURCE_AGE = 36 * 3_600_000;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
    return typeof value === "string" ? Date.parse(value) : NaN;
}

function savedBudgetState(value: unknown, now: number): value is BudgetState {
    return record(value) && isBudgetMode(value.mode) && typeof value.reason === "string"
        && Number.isFinite(timestamp(value.updatedAt)) && timestamp(value.updatedAt) <= now + 60_000
        && value.source === "billable-usage" && Array.isArray(value.coverage)
        && value.coverage.every((family) => typeof family === "string" && REQUIRED_COVERAGE.includes(family))
        && (value.estimatedUsd === undefined || (typeof value.estimatedUsd === "number" && Number.isFinite(value.estimatedUsd) && value.estimatedUsd >= 0));
}

function cycleBoundary(anchor: Date, year: number, month: number): number {
    const day = Math.min(anchor.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    return Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds());
}

function billingPeriods(info: unknown, now: number): Map<string, { start: number; end: number }> {
    if (!record(info) || info.success !== true || !record(info.result) || info.result.covered !== true
        || !Array.isArray(info.result.subscriptions) || !info.result.subscriptions.length || info.result.subscriptions.length > 1000) throw new Error("USAGE_INFO_INVALID");
    const periods = new Map<string, { start: number; end: number }>();
    const subscriptionIds = new Set<string>();
    const today = new Date(now);
    for (const subscription of info.result.subscriptions) {
        if (!record(subscription) || typeof subscription.id !== "string" || !subscription.id || subscription.id.length > 128 || subscriptionIds.has(subscription.id)) throw new Error("USAGE_INFO_INVALID");
        subscriptionIds.add(subscription.id);
        const anchorTime = timestamp(subscription.billing_cycle_anchor_timestamp);
        const started = timestamp(subscription.start_timestamp);
        const ended = subscription.end_timestamp === undefined ? Infinity : timestamp(subscription.end_timestamp);
        if (!Number.isFinite(anchorTime) || !Number.isFinite(started) || Number.isNaN(ended) || started > now || anchorTime > now || ended <= started) throw new Error("USAGE_INFO_INVALID");
        const anchor = new Date(anchorTime);
        let month = today.getUTCMonth();
        if (cycleBoundary(anchor, today.getUTCFullYear(), month) > now) month--;
        const period = {
            start: Math.max(started, cycleBoundary(anchor, today.getUTCFullYear(), month)),
            end: Math.min(ended, cycleBoundary(anchor, today.getUTCFullYear(), month + 1)),
        };
        // Info includes cancelled subscriptions. An ended historic cycle must not
        // make today's otherwise unique subscription ambiguous.
        if (period.end > period.start) periods.set(subscription.id, period);
    }
    if (!periods.size) throw new Error("USAGE_INFO_INVALID");
    return periods;
}

function serviceCoverage(row: Partial<UsageRow>): string[] {
    const label = `${row.ServiceFamilyName ?? ""} ${row.ServiceName ?? ""} ${row.ChargeDescription ?? ""}`.toLowerCase();
    const coverage: string[] = [];
    if (/workers/.test(label) && !/\bkv\b|\blogs?\b/.test(label)) coverage.push("workers", "pages");
    if (/\bd1\b/.test(label)) coverage.push("d1");
    if (/\br2\b/.test(label)) coverage.push("r2");
    if (/durable/.test(label)) coverage.push("durable-objects");
    if (/email|mail sending/.test(label)) coverage.push("email");
    if (/\blogs?\b/.test(label)) coverage.push("logs");
    if (/\bkv\b/.test(label)) coverage.push("kv");
    return coverage;
}

export function estimateUsage(value: unknown, now: number, info: unknown): Pick<BudgetState, "estimatedUsd" | "coverage" | "sourceUpdatedAt"> {
    const periods = billingPeriods(info, now);
    if (!value || typeof value !== "object" || !("success" in value) || value.success !== true || !("result" in value) || !Array.isArray(value.result)
        || value.result.length < 1 || value.result.length > 5000) throw new Error("USAGE_DATA_INVALID");
    if ("result_info" in value) {
        const info = value.result_info as { total_count?: number; total_pages?: number };
        if (typeof info.total_count !== "number" || info.total_count !== value.result.length || (info.total_pages ?? 1) !== 1) throw new Error("USAGE_DATA_TRUNCATED");
    }
    const costs = new Map<string, { cost: number; newest: number }>();
    const families = new Set<string>();
    for (const raw of value.result) {
        if (!raw || typeof raw !== "object") throw new Error("USAGE_DATA_INVALID");
        const row = raw as Partial<UsageRow>;
        if (["SubscriptionId", "ZoneId", "ServiceFamilyName", "x_BillableMetricId"].some((field) => {
            const value = (raw as Record<string, unknown>)[field];
            return value !== undefined && typeof value !== "string";
        })) throw new Error("USAGE_DATA_INVALID");
        if (row.BillingCurrency !== "USD" || typeof row.ServiceName !== "string" || !row.ServiceName
            || typeof row.PricingUnit !== "string" || !row.PricingUnit.trim()
            || typeof row.ChargeDescription !== "string" || !row.ChargeDescription.trim()
            || typeof row.CumulatedContractedCost !== "number" || !Number.isFinite(row.CumulatedContractedCost) || row.CumulatedContractedCost < 0
            || typeof row.ChargePeriodEnd !== "string" || !Number.isFinite(Date.parse(row.ChargePeriodEnd))
            || typeof row.BillingPeriodStart !== "string" || !Number.isFinite(Date.parse(row.BillingPeriodStart))) throw new Error("USAGE_DATA_INVALID");
        const end = Date.parse(row.ChargePeriodEnd);
        const subscriptionId = row.SubscriptionId ?? (periods.size === 1 ? periods.keys().next().value : undefined);
        const period = subscriptionId ? periods.get(subscriptionId) : undefined;
        if (!period || Date.parse(row.BillingPeriodStart) !== period.start || end <= period.start || end > period.end || end > now + 86_400_000) throw new Error("USAGE_PERIOD_INVALID");
        const key = JSON.stringify([row.ServiceName, subscriptionId, row.ZoneId, row.ChargeDescription, row.PricingUnit, row.x_BillableMetricId]);
        const previous = costs.get(key);
        costs.set(key, { cost: Math.max(previous?.cost ?? 0, row.CumulatedContractedCost), newest: Math.max(previous?.newest ?? 0, end) });
        for (const family of serviceCoverage(row)) families.add(family);
    }
    // Missing rows may mean zero usage, unavailable product coverage, or an incomplete
    // feed. Without a complete source we cannot safely distinguish these cases.
    if (REQUIRED_COVERAGE.some((family) => !families.has(family))) throw new Error("USAGE_COVERAGE_INCOMPLETE");
    // This API currently updates daily; older values cannot authorize normal operation.
    const oldestMetric = Math.min(...Array.from(costs.values(), (metric) => metric.newest));
    if (now - oldestMetric > MAX_SOURCE_AGE) throw new Error("USAGE_DATA_STALE");
    // Usage API excludes recurring subscriptions. Reserve $5 for Workers Paid.
    const estimatedUsd = Math.ceil((5 + Array.from(costs.values()).reduce((sum, metric) => sum + metric.cost, 0)) * 100) / 100;
    if (!Number.isFinite(estimatedUsd)) throw new Error("USAGE_DATA_INVALID");
    return { estimatedUsd, coverage: Array.from(families).sort(), sourceUpdatedAt: new Date(oldestMetric).toISOString() };
}

export function nextBudgetState(previous: BudgetState | null, estimate: Pick<BudgetState, "estimatedUsd" | "coverage" | "sourceUpdatedAt"> | null, now: number): BudgetState {
    let mode: BudgetMode = !estimate ? "restricted" : (estimate.estimatedUsd ?? 0) >= 18 ? "maintenance" : (estimate.estimatedUsd ?? 0) >= 15 ? "restricted" : "normal";
    let reason = !estimate ? "usage_source_unavailable" : (estimate.estimatedUsd ?? 0) >= 18 ? "budget_stop" : (estimate.estimatedUsd ?? 0) >= 15 ? "budget_restricted" : (estimate.estimatedUsd ?? 0) >= 10 ? "budget_warning" : "within_budget";
    if (previous && RANK[previous.mode] > RANK[mode]) { mode = previous.mode; reason = "manual_recovery_required"; }
    return {
        mode, reason, updatedAt: new Date(now).toISOString(), source: "billable-usage",
        estimatedUsd: estimate?.estimatedUsd ?? previous?.estimatedUsd,
        coverage: estimate?.coverage ?? [], sourceUpdatedAt: estimate?.sourceUpdatedAt,
    };
}

async function cloudflareJson(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("CLOUDFLARE_API_UNAVAILABLE");
    const raw = await readBounded(response, 2 * 1024 * 1024);
    if (raw === null) throw new Error("CLOUDFLARE_RESPONSE_TOO_LARGE");
    return JSON.parse(raw);
}

export function dynamicBlockExpression(origin: string): string {
    const url = new URL(origin);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.origin !== origin || !/^[a-z0-9.-]+$/.test(host)) throw new Error("INVALID_ORIGIN");
    return `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/api/") or http.request.uri.path contains "/products/" or http.request.uri.path contains "/shops/" or http.request.uri.path eq "/sitemap.xml" or starts_with(http.request.uri.path, "/sitemaps/")))`;
}

export function mediaBlockExpression(origin: string): string {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new Error("INVALID_ORIGIN");
    return `http.host eq "${url.hostname}"`;
}

interface EdgeStop { dynamic: boolean; media: boolean }
interface EdgeRule { id: string; action: string; expression: string; enabled?: boolean }

function entrypointRules(value: unknown, id: string): EdgeRule[] | null {
    if (!record(value) || value.success !== true || !record(value.result) || value.result.id !== id
        || value.result.kind !== "zone" || value.result.phase !== "http_request_firewall_custom" || !Array.isArray(value.result.rules)) return null;
    const rules: EdgeRule[] = [];
    for (const rule of value.result.rules) {
        if (!record(rule) || typeof rule.id !== "string" || typeof rule.action !== "string" || typeof rule.expression !== "string"
            || (rule.enabled !== undefined && typeof rule.enabled !== "boolean")) return null;
        rules.push({ id: rule.id, action: rule.action, expression: rule.expression, enabled: rule.enabled });
    }
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return null;
    return rules;
}

function matchingRule(rules: EdgeRule[], id: string, expression: string): EdgeRule | undefined {
    const index = rules.findIndex((rule) => rule.id === id);
    const rule = rules[index];
    // A prior skip may bypass every subsequent custom rule. Do not report a stop
    // as effective or rearrange rules that the operator has not approved.
    if (!rule || rule.action !== "block" || rule.expression !== expression || rules.slice(0, index).some((entry) => entry.action === "skip" && entry.enabled !== false)) return undefined;
    return rule;
}

async function activateEdgeStop(env: SupportEnv): Promise<EdgeStop> {
    const stopped: EdgeStop = { dynamic: false, media: false };
    const validId = (value: string) => /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
    if (!env.CF_API_TOKEN || !validId(env.CF_ZONE_ID) || !validId(env.EDGE_RULESET_ID) || env.EDGE_RULE_ID === env.EDGE_MEDIA_RULE_ID) return stopped;
    const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/rulesets`;
    const entrypoint = `${base}/phases/http_request_firewall_custom/entrypoint`;
    const expected: { key: keyof EdgeStop; id: string; expression: string }[] = [];
    for (const target of [
        { key: "dynamic" as const, id: env.EDGE_RULE_ID, origin: env.ORIGIN, expression: dynamicBlockExpression },
        { key: "media" as const, id: env.EDGE_MEDIA_RULE_ID, origin: env.MEDIA_ORIGIN, expression: mediaBlockExpression },
    ]) {
        if (!validId(target.id)) continue;
        try { expected.push({ key: target.key, id: target.id, expression: target.expression(target.origin) }); }
        catch { /* An invalid host must not disable the other configured stop. */ }
    }
    if (!expected.length) return stopped;
    let rules = entrypointRules(await cloudflareJson(entrypoint, env.CF_API_TOKEN), env.EDGE_RULESET_ID);
    if (!rules) return stopped;
    let attempted = false;
    for (const target of expected) {
        if (!validId(target.id)) continue;
        const rule = matchingRule(rules, target.id, target.expression);
        if (!rule) continue;
        if (rule.enabled === true) { stopped[target.key] = true; continue; }
        attempted = true;
        try {
            await cloudflareJson(`${base}/${env.EDGE_RULESET_ID}/rules/${target.id}`, env.CF_API_TOKEN, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        } catch { /* A failed/uncertain write must not prevent the other stop. */ }
    }
    if (attempted) {
        // PATCH success alone cannot prove that the active entry point blocks.
        // Read it once even after an uncertain write; never retry the mutation.
        rules = entrypointRules(await cloudflareJson(entrypoint, env.CF_API_TOKEN), env.EDGE_RULESET_ID);
        for (const target of expected) stopped[target.key] = Boolean(rules && matchingRule(rules, target.id, target.expression)?.enabled === true);
    }
    return stopped;
}

async function alert(env: SupportEnv, state: BudgetState): Promise<void> {
    if (!env.ALERT_EMAIL || !/^[^\s@]+@[^\s@]+$/.test(env.ALERT_EMAIL)) return;
    const day = new Date().toISOString().slice(0, 10);
    const permitted = await reserve(env, `alert:${state.mode}:${state.reason}:${day}`, [
        { key: `alerts:once:${state.mode}:${state.reason}`, limit: 1, windowSeconds: 86400 },
        { key: "alerts:day", limit: 6, windowSeconds: 86400 },
        { key: "alerts:month", limit: 40, windowSeconds: 2_678_400, period: "month" },
    ]);
    if (!permitted.allowed) return;
    await env.EMAIL.send({
        from: { email: env.EMAIL_FROM, name: "VRCLearn Store Operations" }, to: env.ALERT_EMAIL,
        subject: `VRCLearn Store: ${state.mode} (${state.reason})`,
        text: `Mode: ${state.mode}\nReason: ${state.reason}\nEstimated account usage plus base plan: ${state.estimatedUsd === undefined ? "unavailable" : `$${state.estimatedUsd}`}\nSource: ${state.source}\nUpdated: ${state.updatedAt}\nAutomatic recovery is disabled. Inspect the Cloudflare dashboard before manually restoring service.`,
    });
}

export async function runMonitor(env: SupportEnv): Promise<BudgetState> {
    let previous: BudgetState | null = null;
    let stateUnavailable = false;
    try {
        const stored = await env.STATE.get<unknown>("budget:state", "json");
        if (stored !== null) {
            if (!savedBudgetState(stored, Date.now())) throw new Error("BUDGET_STATE_INVALID");
            previous = stored;
        }
    } catch { stateUnavailable = true; }
    let estimate: ReturnType<typeof estimateUsage> | null = null;
    try {
        if (stateUnavailable) throw new Error("BUDGET_STATE_UNAVAILABLE");
        if (!env.CF_MONITOR_TOKEN || !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)) throw new Error("MONITOR_NOT_CONFIGURED");
        const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage`;
        const info = await cloudflareJson(`${base}/info`, env.CF_MONITOR_TOKEN);
        estimate = estimateUsage(await cloudflareJson(base, env.CF_MONITOR_TOKEN), Date.now(), info);
    } catch { /* Missing or unverified cost data must never be treated as zero usage. */ }
    const next = nextBudgetState(previous, estimate, Date.now());
    const failState = () => { next.mode = "maintenance"; next.reason = "budget_state_unavailable"; };
    if (stateUnavailable) failState();
    // Persist the application gate before attempting email or external rules.
    try { await env.STATE.put("budget:state", JSON.stringify(next)); }
    catch { failState(); }
    if (next.mode === "maintenance") {
        let stopped: EdgeStop = { dynamic: false, media: false };
        try { stopped = await activateEdgeStop(env); } catch { /* Application gates remain closed. */ }
        next.edgeDynamicBlocked = stopped.dynamic;
        next.edgeMediaBlocked = stopped.media;
        next.edgeBlocked = stopped.dynamic && stopped.media;
        try { await env.STATE.put("budget:state", JSON.stringify(next)); }
        catch { console.warn(JSON.stringify({ event: "budget_state_write_failed" })); }
    }
    if (next.mode !== "normal" || (next.estimatedUsd ?? 0) >= 10) {
        try { await alert(env, next); } catch { console.warn(JSON.stringify({ event: "budget_alert_failed", mode: next.mode })); }
    }
    console.info(JSON.stringify({ event: "budget_check", mode: next.mode, reason: next.reason, estimatedUsd: next.estimatedUsd, edgeBlocked: next.edgeBlocked }));
    return next;
}
