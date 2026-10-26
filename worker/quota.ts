import { DurableObject } from "cloudflare:workers";
import { reserveQuota, validQuotaRequest } from "./quota-core";
import type { SupportEnv } from "./env";
import { readBounded } from "./http";

export class QuotaGate extends DurableObject<SupportEnv> {
    async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/reserve") return new Response("Not found", { status: 404 });
        const raw = await readBounded(request, 8192);
        if (raw === null) return new Response("Payload too large", { status: 413 });
        let input: unknown;
        try { input = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }
        if (!validQuotaRequest(input)) return new Response("Invalid quota request", { status: 400 });
        const result = await this.ctx.storage.transaction((tx) => reserveQuota(tx, input, Date.now()));
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
        return Response.json(result, { status: result.allowed ? 200 : 429, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {} });
    }

    async alarm(): Promise<void> {
        const cursor = await this.ctx.storage.get<string>("cleanup-cursor");
        const entries = await this.ctx.storage.list<{ expiresAt?: number }>({ startAfter: cursor, limit: 1000 });
        const expired: string[] = [];
        let last: string | undefined;
        for (const [key, value] of entries) {
            last = key;
            if (typeof value === "object" && value !== null && typeof value.expiresAt === "number" && value.expiresAt <= Date.now()) expired.push(key);
        }
        if (expired.length) await this.ctx.storage.delete(expired);
        if (entries.size === 1000 && last) await this.ctx.storage.put("cleanup-cursor", last);
        else await this.ctx.storage.delete("cleanup-cursor");
        await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    }
}
