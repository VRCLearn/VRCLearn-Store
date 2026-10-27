export type BudgetMode = "normal" | "restricted" | "maintenance";

export function isBudgetMode(value: unknown): value is BudgetMode {
    return value === "normal" || value === "restricted" || value === "maintenance";
}

interface BudgetEnvironment {
    STATE: Pick<KVNamespace, "get">;
    ENVIRONMENT: string;
}

export async function serviceEnabled(env: BudgetEnvironment, highCost = false): Promise<boolean> {
    let value: unknown;
    try { value = await env.STATE.get("budget:state", "json"); }
    catch { return false; }
    const budget = value && typeof value === "object" && !Array.isArray(value)
        ? value as { mode?: unknown; updatedAt?: unknown }
        : null;
    if (budget?.mode === "maintenance") return false;
    if (!highCost) return true;
    if (budget?.mode === "restricted") return false;
    if (env.ENVIRONMENT !== "production") return true;
    if (budget?.mode !== "normal" || typeof budget.updatedAt !== "string") return false;
    const checked = Date.parse(budget.updatedAt);
    const now = Date.now();
    return Number.isFinite(checked) && now - checked <= 1_800_000 && checked <= now + 60_000;
}
