import { z } from "zod";
import type { Region, SessionUser } from "../shared/contracts";
import type { AppEnv } from "./env";
import { serviceEnabled } from "../edge/budget";
import { validQuotaResponse } from "../worker/quota-core";

export class HttpError extends Error {
    constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
        super(message);
    }
}

export function country(request: Request): string {
    const cf = (request as Request & { cf?: { country?: string } }).cf;
    if (!cf?.country || ["XX", "T1"].includes(cf.country)) {
        throw new HttpError(403, "REGION_UNKNOWN", "Your access region could not be verified.");
    }
    return cf.country;
}

export function regionOf(request: Request): Region {
    return country(request) === "CN" ? "cn" : "intl";
}

export function secureOrigin(request: Request, env: AppEnv): void {
    const origin = request.headers.get("Origin");
    if (origin !== env.ORIGIN) {
        throw new HttpError(403, "ORIGIN_REJECTED", "The request origin is not allowed.");
    }
    const site = request.headers.get("Sec-Fetch-Site");
    if (site && !["same-origin", "none"].includes(site)) {
        throw new HttpError(403, "CSRF_REJECTED", "Cross-site operations are not permitted.");
    }
}

export async function readBytes(request: Request, maximum: number): Promise<Uint8Array> {
    const declared = request.headers.get("Content-Length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
        throw new HttpError(413, "BODY_TOO_LARGE", "The request body exceeds the allowed size.");
    }
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const item = await reader.read();
            if (item.done) break;
            length += item.value.byteLength;
            if (length > maximum) {
                await reader.cancel();
                throw new HttpError(413, "BODY_TOO_LARGE", "The request body exceeds the allowed size.");
            }
            chunks.push(item.value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

export async function jsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
        throw new HttpError(415, "JSON_REQUIRED", "Use an application/json request body.");
    }
    try {
        return schema.parse(JSON.parse(new TextDecoder().decode(await readBytes(request, 49152))));
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "INVALID_INPUT", "The request contains invalid or unsupported values.");
    }
}

export async function session(request: Request, env: AppEnv, admin = false): Promise<SessionUser> {
    const response = await env.AUTH.fetch(new Request("https://support.internal/internal/session", { headers: request.headers }));
    if (!response.ok) throw new HttpError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable.");
    const payload = await response.json() as SessionUser | { user: SessionUser | null } | null;
    const user = payload && "user" in payload ? payload.user : payload;
    if (!user || !user.emailVerified) throw new HttpError(401, "SIGN_IN_REQUIRED", "Sign in with a verified email address.");
    if (user.banned) throw new HttpError(403, "ACCOUNT_RESTRICTED", "This account is restricted.");
    if (admin && (user.role !== "admin" || !user.twoFactorEnabled || !user.twoFactorVerified)) {
        throw new HttpError(403, "ADMIN_MFA_REQUIRED", "An administrator session verified with MFA is required.");
    }
    return user;
}

export interface QuotaLimit {
    key: string;
    limit: number;
    windowSeconds: number;
    amount?: number;
    period?: "month";
}

export async function reserve(env: AppEnv, limits: QuotaLimit[], key = crypto.randomUUID()): Promise<void> {
    let response: Response;
    let value: unknown;
    try {
        const stub = env.QUOTA.getByName("global");
        response = await stub.fetch("https://quota.internal/reserve", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, limits }),
        });
        if (response.status !== 200 && response.status !== 429) throw new Error("QUOTA_UNAVAILABLE");
        value = await response.json();
    } catch {
        throw new HttpError(503, "QUOTA_UNAVAILABLE", "This operation is temporarily paused.");
    }
    if (!validQuotaResponse(value, response.status)) {
        throw new HttpError(503, "QUOTA_UNAVAILABLE", "This operation is temporarily paused.");
    }
    if (!value.allowed) throw new HttpError(value.duplicate ? 409 : 429, value.duplicate ? "DUPLICATE_OPERATION" : "QUOTA_EXCEEDED", "This operation is limited. Please try again later.", value.retryAfter ?? 60);
}

export async function publicRate(request: Request, env: AppEnv): Promise<void> {
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) throw new HttpError(403, "CLIENT_UNVERIFIED", "The request could not be verified at the service edge.");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    const key = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
    await reserve(env, [
        { key: `read:ip:${key}:minute`, limit: 60, windowSeconds: 60 },
        { key: `read:ip:${key}:day`, limit: 1000, windowSeconds: 86400 },
        { key: "read:global:day", limit: 45000, windowSeconds: 86400 },
    ]);
}

export async function turnstile(request: Request, env: AppEnv, token: string, expectedAction: "upload" | "submit"): Promise<void> {
    if (!env.TURNSTILE_SECRET_KEY || !token) throw new HttpError(503, "VERIFICATION_REQUIRED", "Human verification is required before this operation.");
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) form.set("remoteip", ip);
    try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(6000) });
        const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
        if (!result.success || result.hostname !== new URL(env.ORIGIN).hostname || result.action !== expectedAction) throw new HttpError(403, "VERIFICATION_FAILED", "Human verification failed or expired.");
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "VERIFICATION_UNAVAILABLE", "Human verification is temporarily unavailable.");
    }
}

export async function mode(env: AppEnv, highCost = false): Promise<void> {
    if (!await serviceEnabled(env, highCost)) {
        throw new HttpError(503, "SERVICE_PAUSED", "This operation is temporarily paused to protect service capacity.");
    }
}

export function isPublicHttps(value: string): boolean {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
        if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host.includes(":")) return false;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const [a, b] = host.split(".").map(Number);
            return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
        }
        return true;
    } catch {
        return false;
    }
}

export function failure(error: unknown, requestId = crypto.randomUUID()): Response {
    const known = error instanceof HttpError;
    if (!known) console.error(JSON.stringify({ event: "request_failed", requestId, name: error instanceof Error ? error.name : "UnknownError" }));
    return Response.json({ error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "The request could not be completed.", requestId } }, {
        status: known ? error.status : 500,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
    });
}
