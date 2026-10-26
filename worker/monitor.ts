import type { SupportEnv } from "./env";
import { reserve } from "./email";
import { readBounded } from "./http";

export type BudgetMode = "normal" | "restricted" | "maintenance";
export interface BudgetState {
    mode: BudgetMode;
    updatedAt: string;
    reason: string;
    estimatedUsd?: number;
    source: "billable-usage";
    coverage: string[];
    sourceUpdatedAt?: string;
    edgeBlocked?: boolean;
}
interface UsageRow {
    ServiceName: string;
    ServiceFamilyName?: string;
    BillingCurrency: string;
    CumulatedContractedCost: number;
    ChargePeriodEnd: string;
    BillingPeriodStart: string;
    SubscriptionId?: string;
    PricingUnit?: string;
    ChargeDescription?: string;
    x_BillableMetricId?: string;
}
const RANK: Record<BudgetMode, number> = { normal: 0, restricted: 1, maintenance: 2 };
const REQUIRED_COVERAGE = ["workers", "pages", "d1", "r2", "durable-objects", "email", "logs", "kv"];

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

export function estimateUsage(value: unknown, now: number): Pick<BudgetState, "estimatedUsd" | "coverage" | "sourceUpdatedAt"> {
    if (!value || typeof value !== "object" || !("success" in value) || value.success !== true || !("result" in value) || !Array.isArray(value.result)
        || value.result.length < 1 || value.result.length > 5000) throw new Error("USAGE_DATA_INVALID");
    if ("result_info" in value) {
        const info = value.result_info as { total_count?: number; total_pages?: number };
        if (typeof info.total_count !== "number" || info.total_count !== value.result.length || (info.total_pages ?? 1) !== 1) throw new Error("USAGE_DATA_TRUNCATED");
    }
    const costs = new Map<string, number>();
    const families = new Set<string>();
    let newest = 0;
    for (const raw of value.result) {
        if (!raw || typeof raw !== "object") throw new Error("USAGE_DATA_INVALID");
        const row = raw as Partial<UsageRow>;
        if (row.BillingCurrency !== "USD" || typeof row.ServiceName !== "string" || !row.ServiceName
            || typeof row.CumulatedContractedCost !== "number" || !Number.isFinite(row.CumulatedContractedCost) || row.CumulatedContractedCost < 0
            || typeof row.ChargePeriodEnd !== "string" || !Number.isFinite(Date.parse(row.ChargePeriodEnd))
            || typeof row.BillingPeriodStart !== "string" || !Number.isFinite(Date.parse(row.BillingPeriodStart))) throw new Error("USAGE_DATA_INVALID");
        const end = Date.parse(row.ChargePeriodEnd);
        if (end > now + 86_400_000) throw new Error("USAGE_DATA_INVALID");
        newest = Math.max(newest, end);
        const key = [row.ServiceName, row.SubscriptionId, row.x_BillableMetricId ?? row.ChargeDescription, row.PricingUnit, row.BillingPeriodStart].join("|");
        costs.set(key, Math.max(costs.get(key) ?? 0, row.CumulatedContractedCost));
        for (const family of serviceCoverage(row)) families.add(family);
    }
    // Missing rows may mean zero usage, unavailable product coverage, or an incomplete
    // feed. Without a complete source we cannot safely distinguish these cases.
    if (REQUIRED_COVERAGE.some((family) => !families.has(family))) throw new Error("USAGE_COVERAGE_INCOMPLETE");
    // This API currently updates daily; older values cannot authorize normal operation.
    if (now - newest > 36 * 3_600_000) throw new Error("USAGE_DATA_STALE");
    // Usage API excludes recurring subscriptions. Reserve $5 for Workers Paid.
    const estimatedUsd = Math.ceil((5 + Array.from(costs.values()).reduce((sum, cost) => sum + cost, 0)) * 100) / 100;
    return { estimatedUsd, coverage: Array.from(families).sort(), sourceUpdatedAt: new Date(newest).toISOString() };
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
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("CLOUDFLARE_API_UNAVAILABLE");
    const raw = await readBounded(response, 2 * 1024 * 1024);
    if (raw === null) throw new Error("CLOUDFLARE_RESPONSE_TOO_LARGE");
    return JSON.parse(raw);
}

export function dynamicBlockExpression(origin: string): string {
    const host = new URL(origin).hostname;
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("INVALID_ORIGIN");
    return `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/api/") or http.request.uri.path contains "/products/" or http.request.uri.path contains "/shops/" or http.request.uri.path eq "/sitemap.xml" or starts_with(http.request.uri.path, "/sitemaps/")))`;
}

async function activateEdgeStop(env: SupportEnv): Promise<boolean> {
    if (!env.CF_API_TOKEN || !/^[a-f0-9]{32}$/.test(env.CF_ZONE_ID) || !/^[a-f0-9]{32}$/.test(env.EDGE_RULESET_ID) || !/^[a-f0-9]{32}$/.test(env.EDGE_RULE_ID)) return false;
    const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/rulesets/${env.EDGE_RULESET_ID}`;
    const document = await cloudflareJson(base, env.CF_API_TOKEN);
    if (!document || typeof document !== "object" || !("result" in document)) return false;
    const result = document.result as { rules?: { id: string; action: string; expression: string; enabled?: boolean }[] };
    const rule = result.rules?.find((entry) => entry.id === env.EDGE_RULE_ID);
    if (!rule || rule.action !== "block" || rule.expression !== dynamicBlockExpression(env.ORIGIN)) return false;
    if (rule.enabled === true) return true;
    const updated = await cloudflareJson(`${base}/rules/${env.EDGE_RULE_ID}`, env.CF_API_TOKEN, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    return Boolean(updated && typeof updated === "object" && "success" in updated && updated.success === true);
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
    const previous = await env.STATE.get<BudgetState>("budget:state", "json");
    let estimate: ReturnType<typeof estimateUsage> | null = null;
    try {
        if (!env.CF_MONITOR_TOKEN || !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)) throw new Error("MONITOR_NOT_CONFIGURED");
        estimate = estimateUsage(await cloudflareJson(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage`, env.CF_MONITOR_TOKEN), Date.now());
    } catch { /* Missing or unverified cost data must never be treated as zero usage. */ }
    const next = nextBudgetState(previous, estimate, Date.now());
    // Persist the application gate before attempting email or external rules.
    await env.STATE.put("budget:state", JSON.stringify(next));
    if (next.mode === "maintenance") {
        try { next.edgeBlocked = await activateEdgeStop(env); } catch { next.edgeBlocked = false; }
        await env.STATE.put("budget:state", JSON.stringify(next));
    }
    if (next.mode !== "normal" || (next.estimatedUsd ?? 0) >= 10) {
        try { await alert(env, next); } catch { console.warn(JSON.stringify({ event: "budget_alert_failed", mode: next.mode })); }
    }
    console.info(JSON.stringify({ event: "budget_check", mode: next.mode, reason: next.reason, estimatedUsd: next.estimatedUsd, edgeBlocked: next.edgeBlocked }));
    return next;
}
