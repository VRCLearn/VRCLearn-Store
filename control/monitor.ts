import type { ControlEnv } from "./env";
import { reserve } from "../worker/email";
import { readBounded } from "../worker/http";
import { isBudgetMode, type BudgetMode } from "../edge/budget";

export type { BudgetMode } from "../edge/budget";
export interface BudgetState {
    mode: BudgetMode;
    updatedAt: string;
    reason: string;
    estimatedUsd?: number;
    source: "billable-usage";
    coverage: string[];
    coverageBasis?: "provider-account";
    sourceUpdatedAt?: string;
    edgeBlocked?: boolean;
    edgeDynamicBlocked?: boolean;
    edgeMediaBlocked?: boolean;
    environments?: Record<"production" | "test", EnvironmentBudgetState>;
}
export interface EnvironmentBudgetState {
    mode: BudgetMode;
    reason: string;
    delivered: boolean;
    edgeDynamicBlocked: boolean;
    edgeMediaBlocked: boolean;
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
const OBSERVED_FAMILIES = ["workers", "pages", "d1", "r2", "durable-objects", "email", "logs", "kv"];
const MAX_SOURCE_AGE = 36 * 3_600_000;

interface UsageEstimate {
    estimatedUsd: number;
    coverage: string[];
    coverageBasis: "provider-account";
    sourceUpdatedAt: string;
}

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
        && value.coverage.every((family) => typeof family === "string" && OBSERVED_FAMILIES.includes(family))
        && (value.coverageBasis === undefined || value.coverageBasis === "provider-account")
        && (value.estimatedUsd === undefined || (typeof value.estimatedUsd === "number" && Number.isFinite(value.estimatedUsd) && value.estimatedUsd >= 0))
        && (value.environments === undefined || (record(value.environments)
            && Object.keys(value.environments).length === 2
            && ["production", "test"].every((name) => {
                const item = (value.environments as Record<string, unknown>)[name];
                return record(item) && isBudgetMode(item.mode) && typeof item.reason === "string"
                    && typeof item.delivered === "boolean" && typeof item.edgeDynamicBlocked === "boolean" && typeof item.edgeMediaBlocked === "boolean";
            })));
}

function cycleBoundary(anchor: Date, year: number, month: number): number {
    const day = Math.min(anchor.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    return Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds());
}

function billingPeriods(info: unknown, now: number): Map<string, { start: number; end: number }> {
    if (!record(info) || info.success !== true || !record(info.result) || info.result.covered !== true
        || (info.errors !== undefined && (!Array.isArray(info.errors) || info.errors.length !== 0))
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

export function billingUsageWindow(info: unknown, now: number): URLSearchParams {
    const periods = billingPeriods(info, now);
    const firstStart = Math.min(...Array.from(periods.values(), (period) => period.start));
    const today = new Date(now);
    // V1's default window spans billing cycles. Explicit dates must include every
    // current subscription anchor; the estimator still rejects any foreign cycle.
    return new URLSearchParams({
        from: new Date(firstStart).toISOString().slice(0, 10),
        to: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString().slice(0, 10),
    });
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

export function estimateUsage(value: unknown, now: number, info: unknown): UsageEstimate {
    const periods = billingPeriods(info, now);
    if (!record(value) || value.success !== true || !Array.isArray(value.result)
        || value.result.length < 1 || value.result.length > 5000
        || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length !== 0))) throw new Error("USAGE_DATA_INVALID");
    if ("result_info" in value) {
        const info = value.result_info;
        if (!record(info) || typeof info.total_count !== "number" || info.total_count !== value.result.length
            || (info.total_pages ?? 1) !== 1 || (info.page ?? 1) !== 1 || (info.count ?? value.result.length) !== value.result.length) throw new Error("USAGE_DATA_TRUNCATED");
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
    // Cloudflare documents V1 as covering every usage-based product on a covered
    // account. A complete current-cycle response is the account-level authority;
    // the observed families below do not claim that absent products had zero usage.
    // https://blog.cloudflare.com/billable-usage-api/
    // This API currently updates daily; older values cannot authorize normal operation.
    const oldestMetric = Math.min(...Array.from(costs.values(), (metric) => metric.newest));
    if (now - oldestMetric > MAX_SOURCE_AGE) throw new Error("USAGE_DATA_STALE");
    // Usage API excludes recurring subscriptions. Reserve $5 for Workers Paid.
    const estimatedUsd = Math.ceil((5 + Array.from(costs.values()).reduce((sum, metric) => sum + metric.cost, 0)) * 100) / 100;
    if (!Number.isFinite(estimatedUsd)) throw new Error("USAGE_DATA_INVALID");
    return { estimatedUsd, coverage: Array.from(families).sort(), coverageBasis: "provider-account", sourceUpdatedAt: new Date(oldestMetric).toISOString() };
}

export function nextBudgetState(previous: BudgetState | null, estimate: UsageEstimate | null, now: number): BudgetState {
    let mode: BudgetMode = !estimate ? "restricted" : (estimate.estimatedUsd ?? 0) >= 18 ? "maintenance" : (estimate.estimatedUsd ?? 0) >= 15 ? "restricted" : "normal";
    let reason = !estimate ? "usage_source_unavailable" : (estimate.estimatedUsd ?? 0) >= 18 ? "budget_stop" : (estimate.estimatedUsd ?? 0) >= 15 ? "budget_restricted" : (estimate.estimatedUsd ?? 0) >= 10 ? "budget_warning" : "within_budget";
    if (previous && RANK[previous.mode] > RANK[mode]) { mode = previous.mode; reason = "manual_recovery_required"; }
    return {
        mode, reason, updatedAt: new Date(now).toISOString(), source: "billable-usage",
        estimatedUsd: estimate?.estimatedUsd ?? previous?.estimatedUsd,
        coverage: estimate?.coverage ?? [], coverageBasis: estimate?.coverageBasis, sourceUpdatedAt: estimate?.sourceUpdatedAt,
    };
}

async function cloudflareJson(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
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

export function sharedDynamicBlockExpression(origins: string[]): string {
    return sharedExpression(origins, dynamicBlockExpression);
}

export function sharedMediaBlockExpression(origins: string[]): string {
    return sharedExpression(origins, mediaBlockExpression);
}

function sharedExpression(origins: string[], expression: (origin: string) => string): string {
    const values = [...new Set(origins)].sort();
    if (!values.length || values.length > 2) throw new Error("INVALID_STOP_SCOPE");
    const expressions = values.map(expression);
    return expressions.length === 1 ? expressions[0] : `(${expressions.join(" or ")})`;
}

export interface EdgeStop { dynamic: boolean; media: boolean }
export interface StopTarget {
    name: "production" | "test";
    origin: string;
    mediaOrigin: string;
    dynamicRuleId: string;
    mediaRuleId: string;
    blocked: boolean;
}
export interface EdgeStopResult {
    targets: Record<"production" | "test", EdgeStop>;
    verified: EdgeStop;
}
interface EdgeRule {
    id: string;
    action: string;
    expression: string;
    enabled?: boolean;
    description?: string;
    ref?: string;
    bare: boolean;
}
const BARE_RULE_FIELDS = new Set(["id", "action", "expression", "enabled", "description", "ref", "version", "last_updated"]);

function entrypointRules(value: unknown, id: string): EdgeRule[] | null {
    if (!record(value) || value.success !== true || !record(value.result) || value.result.id !== id
        || value.result.kind !== "zone" || value.result.phase !== "http_request_firewall_custom" || !Array.isArray(value.result.rules)) return null;
    const rules: EdgeRule[] = [];
    for (const rule of value.result.rules) {
        if (!record(rule) || typeof rule.id !== "string" || typeof rule.action !== "string" || typeof rule.expression !== "string"
            || (rule.enabled !== undefined && typeof rule.enabled !== "boolean")
            || ["description", "ref", "version", "last_updated"].some((field) => rule[field] !== undefined && typeof rule[field] !== "string")) return null;
        rules.push({
            id: rule.id, action: rule.action, expression: rule.expression, enabled: rule.enabled,
            description: rule.description as string | undefined, ref: rule.ref as string | undefined,
            bare: Object.keys(rule).every((field) => BARE_RULE_FIELDS.has(field)),
        });
    }
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return null;
    return rules;
}

function matchingRule(rules: EdgeRule[], id: string, expressions: Set<string>): EdgeRule | undefined {
    const index = rules.findIndex((rule) => rule.id === id);
    const rule = rules[index];
    // A prior skip may bypass subsequent custom rules. Only exact definitions
    // generated from the two fixed targets may be replaced or reported active.
    if (!rule || !rule.bare || rule.action !== "block" || !expressions.has(rule.expression) || rules.slice(0, index).some((entry) => entry.action === "skip" && entry.enabled !== false)) return undefined;
    return rule;
}

export function monitorStopTargets(env: ControlEnv, blocked: Record<"production" | "test", boolean>): StopTarget[] {
    return [
        { name: "production", origin: env.PRODUCTION_ORIGIN, mediaOrigin: env.PRODUCTION_MEDIA_ORIGIN, dynamicRuleId: env.PRODUCTION_EDGE_RULE_ID, mediaRuleId: env.PRODUCTION_EDGE_MEDIA_RULE_ID, blocked: blocked.production },
        { name: "test", origin: env.TEST_ORIGIN, mediaOrigin: env.TEST_MEDIA_ORIGIN, dynamicRuleId: env.TEST_EDGE_RULE_ID, mediaRuleId: env.TEST_EDGE_MEDIA_RULE_ID, blocked: blocked.test },
    ];
}

export async function activateEdgeStops(env: ControlEnv, targets: StopTarget[], options: { allowRecovery?: boolean } = {}): Promise<EdgeStopResult> {
    const result: EdgeStopResult = {
        targets: { production: { dynamic: false, media: false }, test: { dynamic: false, media: false } },
        verified: { dynamic: false, media: false },
    };
    const validId = (value: string) => /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
    if (!env.CF_API_TOKEN || !validId(env.CF_ZONE_ID) || !validId(env.EDGE_RULESET_ID)
        || targets.length !== 2 || new Set(targets.map((target) => target.name)).size !== 2
        || !targets.every((target) => ["production", "test"].includes(target.name))) return result;
    const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/rulesets`;
    const entrypoint = `${base}/phases/http_request_firewall_custom/entrypoint`;
    const expected: { key: keyof EdgeStop; id: string; expression: string; enabled: boolean; allowed: Set<string>; origins: string[]; blocked: string[]; combine: (origins: string[]) => string }[] = [];
    const dynamicIds = new Set(targets.map((target) => target.dynamicRuleId));
    const mediaIds = new Set(targets.map((target) => target.mediaRuleId));
    if ([...dynamicIds].some((id) => mediaIds.has(id))) return result;
    for (const group of [
        { key: "dynamic" as const, ids: dynamicIds, origins: targets.map((target) => target.origin), expression: sharedDynamicBlockExpression },
        { key: "media" as const, ids: mediaIds, origins: targets.map((target) => target.mediaOrigin), expression: sharedMediaBlockExpression },
    ]) {
        if (group.ids.size !== 1) continue;
        const id = [...group.ids][0];
        if (!validId(id)) continue;
        try {
            if (new Set(group.origins).size !== 2) continue;
            const allowed = new Set([group.expression([group.origins[0]]), group.expression([group.origins[1]]), group.expression(group.origins)]);
            const blocked = group.origins.filter((_, index) => targets[index].blocked);
            expected.push({ key: group.key, id, expression: group.expression(blocked.length ? blocked : group.origins), enabled: blocked.length > 0, allowed, origins: group.origins, blocked, combine: group.expression });
        } catch { /* An invalid group must not prevent the other stop. */ }
    }
    if (!expected.length) return result;
    let rules: EdgeRule[] | null;
    try { rules = entrypointRules(await cloudflareJson(entrypoint, env.CF_API_TOKEN), env.EDGE_RULESET_ID); }
    catch { return result; }
    if (!rules) return result;
    let attempted = false;
    for (const target of expected) {
        const rule = matchingRule(rules, target.id, target.allowed);
        if (!rule) continue;
        // Normal checks may expand an existing stop, but cannot narrow an
        // operator/emergency stop after an uncertain or concurrent failure.
        if (rule.enabled === true && !options.allowRecovery) {
            const active = target.origins.filter((origin) => rule.expression === target.combine([origin]) || rule.expression === target.combine(target.origins));
            const scope = [...new Set([...target.blocked, ...active])];
            target.expression = target.combine(scope.length ? scope : target.origins);
            target.enabled = scope.length > 0;
        }
        if (rule.enabled === target.enabled && rule.expression === target.expression) continue;
        attempted = true;
        try {
            // Each shared rule is patched at most once after combining every
            // environment's desired state. Never let later fanout overwrite it.
            await cloudflareJson(`${base}/${env.EDGE_RULESET_ID}/rules/${target.id}`, env.CF_API_TOKEN, {
                method: "PATCH", body: JSON.stringify({ action: "block", enabled: target.enabled, expression: target.expression, description: rule.description, ref: rule.ref }),
            });
        } catch { /* Read back uncertain writes without retrying the mutation. */ }
    }
    if (attempted) {
        try { rules = entrypointRules(await cloudflareJson(entrypoint, env.CF_API_TOKEN), env.EDGE_RULESET_ID); }
        catch { return result; }
    }
    for (const target of expected) {
        const verified = rules && matchingRule(rules, target.id, new Set([target.expression]));
        result.verified[target.key] = Boolean(verified && verified.enabled === target.enabled);
        for (const environment of targets) result.targets[environment.name][target.key] = result.verified[target.key] && target.enabled && environment.blocked;
    }
    return result;
}

async function alert(env: ControlEnv, state: BudgetState): Promise<void> {
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
        text: `Mode: ${state.mode}\nReason: ${state.reason}\nEstimated account usage plus base plan: ${state.estimatedUsd === undefined ? "unavailable" : `$${state.estimatedUsd}`}\nSource: ${state.source}\nUpdated: ${state.updatedAt}\nEnvironment results: ${JSON.stringify(state.environments ?? {})}\nAutomatic recovery is disabled. Inspect the Cloudflare dashboard before manually restoring service.`,
    });
}

export async function runMonitor(env: ControlEnv, options: { failClosed?: boolean } = {}): Promise<BudgetState> {
    const targets = [
        { name: "production" as const, state: env.PRODUCTION_STATE, origin: env.PRODUCTION_ORIGIN, mediaOrigin: env.PRODUCTION_MEDIA_ORIGIN, dynamicRuleId: env.PRODUCTION_EDGE_RULE_ID, mediaRuleId: env.PRODUCTION_EDGE_MEDIA_RULE_ID },
        { name: "test" as const, state: env.TEST_STATE, origin: env.TEST_ORIGIN, mediaOrigin: env.TEST_MEDIA_ORIGIN, dynamicRuleId: env.TEST_EDGE_RULE_ID, mediaRuleId: env.TEST_EDGE_MEDIA_RULE_ID },
    ];
    let previous: BudgetState | null = null;
    let stateUnavailable = options.failClosed === true;
    try {
        const stored = await env.STATE.get<unknown>("budget:state", "json");
        if (!savedBudgetState(stored, Date.now())) throw new Error("BUDGET_STATE_INVALID");
        previous = stored;
        const delivery = await env.STATE.get<unknown>("budget:delivery", "json");
        if (!savedBudgetState(delivery, Date.now())) throw new Error("BUDGET_DELIVERY_INVALID");
        const account = RANK[delivery.mode] > RANK[previous.mode] ? delivery : previous;
        previous = { ...account, environments: delivery.environments };
    } catch { stateUnavailable = true; }
    const replicas = await Promise.all(targets.map(async (target) => {
        try {
            const stored = await target.state.get<unknown>("budget:state", "json");
            if (stored !== null && !savedBudgetState(stored, Date.now())) throw new Error("REPLICA_STATE_INVALID");
            return { state: stored as BudgetState | null, failed: false };
        } catch { return { state: null, failed: true }; }
    }));
    // If the authority write failed after an earlier account-wide stop, both
    // isolated replicas retain that latch. A single test replica cannot promote
    // the production/account mode by changing its own local state.
    if (replicas.every((replica) => replica.state?.mode === "maintenance" && replica.state.reason === "budget_state_unavailable")) stateUnavailable = true;
    let estimate: ReturnType<typeof estimateUsage> | null = null;
    try {
        if (stateUnavailable) throw new Error("BUDGET_STATE_UNAVAILABLE");
        if (!env.CF_MONITOR_TOKEN || !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)) throw new Error("MONITOR_NOT_CONFIGURED");
        const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage`;
        const info = await cloudflareJson(`${base}/info`, env.CF_MONITOR_TOKEN);
        const queriedAt = Date.now();
        estimate = estimateUsage(await cloudflareJson(`${base}?${billingUsageWindow(info, queriedAt)}`, env.CF_MONITOR_TOKEN), queriedAt, info);
    } catch { /* Missing or unverified cost data must never be treated as zero usage. */ }
    const next = nextBudgetState(previous, estimate, Date.now());
    if (stateUnavailable) { next.mode = "maintenance"; next.reason = "budget_state_unavailable"; }
    // Commit the account gate before fanout. Use a different key for the final
    // receipts so normal checks never violate KV's same-key write-rate limit.
    try { await env.STATE.put("budget:state", JSON.stringify(next)); }
    catch { next.mode = "maintenance"; next.reason = "budget_state_unavailable"; }
    const environments = {} as Record<"production" | "test", EnvironmentBudgetState>;
    async function distribute(): Promise<void> {
        for (const [index, target] of targets.entries()) {
            const prior = replicas[index];
            const latched = previous?.environments?.[target.name]?.mode === "maintenance" || prior.state?.mode === "maintenance";
            let mode = next.mode === "maintenance" || prior.failed || latched ? "maintenance" as const : next.mode;
            let reason = prior.failed ? "replica_state_unavailable" : latched && next.mode !== "maintenance" ? "manual_recovery_required" : next.reason;
            let delivered = false;
            try {
                // Replicas only contain their own gate, never the authority's
                // per-environment receipts or another environment's resources.
                await target.state.put("budget:state", JSON.stringify({ ...next, environments: undefined, mode, reason }));
                delivered = true;
            } catch { mode = "maintenance"; reason = "replica_state_unavailable"; }
            environments[target.name] = { mode, reason, delivered, edgeDynamicBlocked: false, edgeMediaBlocked: false };
        }
        if (targets.some((target) => environments[target.name].mode === "maintenance")) {
            const stopped = await activateEdgeStops(env, targets.map((target) => ({ ...target, blocked: environments[target.name].mode === "maintenance" })));
            for (const target of targets) {
                environments[target.name].edgeDynamicBlocked = stopped.targets[target.name].dynamic;
                environments[target.name].edgeMediaBlocked = stopped.targets[target.name].media;
            }
        }
        next.environments = environments;
        next.edgeDynamicBlocked = targets.every((target) => environments[target.name].edgeDynamicBlocked);
        next.edgeMediaBlocked = targets.every((target) => environments[target.name].edgeMediaBlocked);
        next.edgeBlocked = next.edgeDynamicBlocked && next.edgeMediaBlocked;
    }
    await distribute();
    let receiptsUnavailable = false;
    try { await env.STATE.put("budget:delivery", JSON.stringify(next)); }
    catch { receiptsUnavailable = true; console.warn(JSON.stringify({ event: "budget_delivery_write_failed" })); }
    const deliveryFailure = targets.some((target) => environments[target.name].mode === "maintenance" && next.mode !== "maintenance");
    if (next.mode !== "normal" || (next.estimatedUsd ?? 0) >= 10 || deliveryFailure || receiptsUnavailable) {
        const alertState = deliveryFailure || receiptsUnavailable ? { ...next, reason: "environment_delivery_failed" } : next;
        try { await alert(env, alertState); }
        catch { console.warn(JSON.stringify({ event: "budget_alert_failed", mode: next.mode })); }
    }
    console.info(JSON.stringify({ event: "budget_check", mode: next.mode, reason: next.reason, estimatedUsd: next.estimatedUsd, edgeBlocked: next.edgeBlocked, environments }));
    return next;
}
