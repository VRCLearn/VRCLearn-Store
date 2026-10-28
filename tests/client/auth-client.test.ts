import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/client";
import { onRequest } from "../../functions/api/auth/[[path]]";
import { handleAuth } from "../../worker/auth";
import type { SupportEnv } from "../../worker/env";
import type { AppEnv } from "../../server/env";
import { ApiError, localizedError } from "../../src/api";
import { messages } from "../../src/i18n";
import { checked } from "../../src/account";
import { testEnvironment } from "../helpers";

// This test exercises the real auth client and UI result handling without
// registering browser-only Material elements in the Node test environment.
vi.mock("../../src/material", () => ({}));
vi.mock("../../src/turnstile", () => ({}));
vi.mock("../../src/ui", () => ({}));

afterEach(() => vi.unstubAllGlobals());

function fixture() {
    const f = testEnvironment();
    const rateLimit = vi.fn(async () => ({ success: true }));
    const support = Object.assign({} as SupportEnv, { ...f.env, AUTH_RATE_LIMIT: { limit: rateLimit } });
    f.env.AUTH = Object.assign({} as Fetcher, { fetch: (request: Request) => handleAuth(request, support) });
    let response: Response | undefined;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const incoming = new Request(input, init);
        const headers = new Headers(incoming.headers);
        headers.set("Origin", f.env.ORIGIN);
        headers.set("CF-Connecting-IP", "203.0.113.5");
        headers.set("x-turnstile-token", "test-token");
        const request = new Request(incoming, { headers });
        const context = Object.assign({} as EventContext<AppEnv, string, Record<string, unknown>>, { request, env: f.env });
        const result = await onRequest(context);
        response = result.clone();
        return result;
    });
    const client = createAuthClient({ baseURL: f.env.ORIGIN, fetchOptions: { customFetchImpl: transport } });
    return { ...f, support, rateLimit, client, transport, response: () => response! };
}

describe("auth errors through the real Better Auth client", () => {
    it.each([
        { guard: "budget", status: 503, code: "FEATURE_PAUSED", message: "actionUnavailable" },
        { guard: "rate", status: 429, code: "RATE_LIMITED", message: "tooManyRequests" },
        { guard: "challenge", status: 403, code: "CHALLENGE_FAILED", message: "verificationExpired" },
    ] as const)("preserves $code, status $status and the request reference for localized UI errors", async ({ guard, status, code, message }) => {
        const f = fixture();
        try {
            if (guard === "budget") f.state.set("budget:state", JSON.stringify({ mode: "restricted", updatedAt: new Date().toISOString() }));
            if (guard === "rate") f.rateLimit.mockResolvedValue({ success: false });
            vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false })));
            const before = f.queries.length;
            const result = await f.client.signUp.email({ name: "Display nickname", email: "test@example.com", password: "a-strong-test-password" });
            expect(result.error).toMatchObject({ code, status, requestId: expect.any(String) });
            const payload = await f.response().json();
            expect(payload).toMatchObject({ code, message: expect.any(String), requestId: expect.any(String) });
            expect(payload).not.toHaveProperty("error");
            expect(f.response().headers.get("X-Request-ID")).toBe(payload.requestId);
            expect(f.response().headers.get("Cache-Control")).toBe("no-store");
            if (guard === "rate") expect(f.response().headers.get("Retry-After")).toBe("60");
            let failure: unknown;
            try { checked(result); } catch (error) { failure = error; }
            expect(failure).toBeInstanceOf(ApiError);
            expect(failure).toMatchObject({ code, status, requestId: payload.requestId });
            for (const locale of ["zh-CN", "en", "ja"] as const) {
                const copy = messages(locale);
                expect(localizedError(failure, copy)).toBe(copy[message]);
            }
            expect(f.transport).toHaveBeenCalledTimes(1);
            expect(f.queries).toHaveLength(before);
        } finally { f.database.close(); }
    });
});
