import type { SupportEnv } from "./env";
import { validQuotaResponse, type QuotaLimit, type QuotaResult } from "./quota-core";

export async function reserve(env: Pick<SupportEnv, "QUOTA">, key: string, limits: QuotaLimit[]): Promise<QuotaResult> {
    const result = await env.QUOTA.getByName("global").fetch(new Request("https://quota.internal/reserve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, limits }),
    }));
    if (result.status !== 200 && result.status !== 429) throw new Error("QUOTA_UNAVAILABLE");
    const value: unknown = await result.json();
    if (!validQuotaResponse(value, result.status)) throw new Error("QUOTA_UNAVAILABLE");
    return value;
}
