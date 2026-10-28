import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureOrigin } from "../server/security";
import { allowedHost } from "../edge/respond";
import { createAuth, getSessionUser, handleAuth } from "../worker/auth";
import type { SupportEnv } from "../worker/env";
import { testEnvironment } from "./helpers";

const password = "only-for-environment-isolation-tests";
const origins = { production: "https://store.vrclearn.com", test: "https://test-store.vrclearn.com" };

function fixture(environment: "production" | "test") {
    const value = testEnvironment();
    value.database.exec(readFileSync("migrations/0002_auth.sql", "utf8"));
    value.database.exec(readFileSync("migrations/0004_remove_mfa.sql", "utf8"));
    value.state.set("budget:state", JSON.stringify({ mode: "normal", updatedAt: new Date().toISOString() }));
    const messages: { text?: string }[] = [];
    const env: SupportEnv = {
        ...value.env,
        QUOTA: Object.assign({} as SupportEnv["QUOTA"], value.env.QUOTA),
        ENVIRONMENT: "production", DEPLOYMENT_ENV: environment, ORIGIN: origins[environment],
        MEDIA_ORIGIN: environment === "test" ? "https://test-store-media.vrclearn.com" : "https://store-media.vrclearn.com",
        BETTER_AUTH_SECRET: `only-for-tests-${environment}-${"x".repeat(32)}`,
        AUTH_RATE_LIMIT: Object.assign({} as RateLimit, { limit: async () => ({ success: true }) }),
        EMAIL: Object.assign({} as SendEmail, { send: async (message: { text?: string }) => { messages.push(message); return { messageId: "test" }; } }),
        EMAIL_FROM: environment === "test" ? "test-noreply@vrclearn.com" : "noreply@vrclearn.com",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        if (String(input) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error("Unexpected external request");
        return Response.json({ success: true, hostname: new URL(env.ORIGIN).hostname, action: "auth" });
    }));
    const request = (path: string, body?: unknown) => new Request(`${env.ORIGIN}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: env.ORIGIN, "content-type": "application/json", "x-turnstile-token": "fixture-token", "cf-connecting-ip": "203.0.113.5" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function signIn() {
        const credentials = { name: "Fixture", email: "isolation@example.com", password };
        const signUp = await handleAuth(request("/sign-up/email", credentials), env);
        expect(signUp.status, await signUp.clone().text()).toBe(200);
        const verification = /https:\/\/[^\s]+/.exec(messages[0]?.text ?? "")?.[0];
        expect(verification).toBeTruthy();
        expect((await handleAuth(new Request(verification!, { headers: { "cf-connecting-ip": "203.0.113.5" } }), env)).status).toBeLessThan(400);
        return handleAuth(request("/sign-in/email", credentials), env);
    }
    return { ...value, env, appEnv: { ...value.env, ORIGIN: env.ORIGIN, MEDIA_ORIGIN: env.MEDIA_ORIGIN }, request, signIn };
}

afterEach(() => vi.unstubAllGlobals());

describe("deployed authentication environment boundaries", () => {
    it.each(["production", "test"] as const)("keeps %s authentication cookies secure and scoped to their issuing host", async (environment) => {
        const f = fixture(environment);
        try {
            const signedIn = await f.signIn();
            expect(signedIn.status, await signedIn.clone().text()).toBe(200);
            const cookies = signedIn.headers.getSetCookie();
            expect(cookies.length).toBeGreaterThan(0);
            for (const cookie of cookies) {
                expect(cookie).toMatch(/(?:^|;)\s*Secure(?:;|$)/i);
                expect(cookie).toMatch(/(?:^|;)\s*HttpOnly(?:;|$)/i);
                expect(cookie).toMatch(/(?:^|;)\s*SameSite=Lax(?:;|$)/i);
                expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
            }
            const cookie = cookies.map((part) => part.split(";")[0]).join("; ");
            const headers = new Headers({ cookie });
            expect(await getSessionUser(createAuth(f.env), f.env, headers)).toMatchObject({ email: "isolation@example.com" });
            // Hold the fixture database constant so rejection proves the secret
            // boundary independently of the additional separate-D1 boundary.
            const otherEnvironment = environment === "test" ? "production" : "test";
            const other = { ...f.env, ORIGIN: origins[otherEnvironment], DEPLOYMENT_ENV: otherEnvironment, BETTER_AUTH_SECRET: `different-fixture-secret-${"y".repeat(32)}` };
            expect(await getSessionUser(createAuth(other), other, headers)).toBeNull();
        } finally { f.database.close(); }
    });

    it.each(["production", "test"] as const)("rejects the other environment's Origin before %s authentication or business writes", async (environment) => {
        const f = fixture(environment);
        try {
            const otherEnvironment = environment === "test" ? "production" : "test";
            const request = f.request("/sign-in/email", { email: "isolation@example.com", password });
            request.headers.set("origin", origins[otherEnvironment]);
            const rate = vi.spyOn(f.env.AUTH_RATE_LIMIT, "limit");
            const before = f.queries.length;
            expect((await handleAuth(request, f.env)).status).toBe(403);
            expect(rate).not.toHaveBeenCalled();
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(before);
            expect(() => secureOrigin(request, f.appEnv)).toThrow("request origin");
            expect(allowedHost(new Request(`${origins[environment]}/api/auth/get-session`), f.appEnv)).toBe(true);
            for (const origin of [origins[otherEnvironment], origins[environment].replace("https:", "http:"), "https://test-vrclearn-store.pages.dev", "https://vrclearn-store.pages.dev"]) {
                const wrongHost = new Request(`${origin}/api/auth/get-session`, { headers: { origin: origins[environment] } });
                expect(allowedHost(wrongHost, f.appEnv), origin).toBe(false);
            }
        } finally { f.database.close(); }
    });
});
