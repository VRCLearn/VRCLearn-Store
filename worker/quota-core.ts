export interface QuotaLimit {
    key: string;
    limit: number;
    windowSeconds: number;
    amount?: number;
    period?: "month";
}
export interface QuotaRequest {
    key: string;
    limits: QuotaLimit[];
}
export interface QuotaResult {
    allowed: boolean;
    retryAfter?: number;
    duplicate?: boolean;
}
export interface QuotaTransaction {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
}
interface Counter { used: number; expiresAt: number }

export function validQuotaResponse(value: unknown, status: number): value is QuotaResult {
    return (status === 200 || status === 429) && typeof value === "object" && value !== null && !Array.isArray(value)
        && "allowed" in value && typeof value.allowed === "boolean" && value.allowed === (status === 200)
        && !(value.allowed && "duplicate" in value && value.duplicate === true)
        && (!("duplicate" in value) || typeof value.duplicate === "boolean")
        && (!("retryAfter" in value) || (typeof value.retryAfter === "number" && Number.isSafeInteger(value.retryAfter) && value.retryAfter >= 1));
}

export function validQuotaRequest(value: unknown): value is QuotaRequest {
    if (!value || typeof value !== "object") return false;
    const input = value as Partial<QuotaRequest>;
    return typeof input.key === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(input.key)
        && Array.isArray(input.limits) && input.limits.length > 0 && input.limits.length <= 12
        && input.limits.every((limit) => limit !== null && typeof limit === "object"
            && typeof limit.key === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(limit.key)
            && Number.isSafeInteger(limit.limit) && limit.limit > 0 && limit.limit <= 1_000_000_000_000
            && Number.isSafeInteger(limit.windowSeconds) && limit.windowSeconds >= 1 && limit.windowSeconds <= 2_678_400
            && (limit.amount === undefined || Number.isSafeInteger(limit.amount) && limit.amount >= 1 && limit.amount <= limit.limit)
            && (limit.period === undefined || limit.period === "month"))
        && new Set(input.limits.map((limit) => limit.key)).size === input.limits.length;
}

export async function reserveQuota(tx: QuotaTransaction, input: QuotaRequest, now: number): Promise<QuotaResult> {
    const reservationKey = `reservation:${input.key}`;
    const previous = await tx.get<{ expiresAt: number }>(reservationKey);
    if (previous && previous.expiresAt > now) {
        return { allowed: false, duplicate: true, retryAfter: Math.max(1, Math.ceil((previous.expiresAt - now) / 1000)) };
    }
    const writes: { key: string; value: Counter }[] = [];
    let retryAfter = 0;
    for (const limit of input.limits) {
        const date = new Date(now);
        const duration = limit.windowSeconds * 1000;
        const start = limit.period === "month" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) : Math.floor(now / duration) * duration;
        const expiresAt = limit.period === "month" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : start + duration;
        const key = `counter:${limit.key}:${start}`;
        const value = await tx.get<Counter>(key);
        const used = value && value.expiresAt > now ? value.used : 0;
        const amount = limit.amount ?? 1;
        if (used + amount > limit.limit) retryAfter = Math.max(retryAfter, Math.ceil((expiresAt - now) / 1000));
        writes.push({ key, value: { used: used + amount, expiresAt } });
    }
    if (retryAfter) return { allowed: false, retryAfter };
    for (const write of writes) await tx.put(write.key, write.value);
    // Quota reservations are one-shot. A duplicate must never authorize another send/write.
    await tx.put(reservationKey, { expiresAt: now + 60 * 60 * 1000 });
    return { allowed: true };
}
