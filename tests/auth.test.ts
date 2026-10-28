import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth, getSessionUser, handleAuth } from "../worker/auth";
import { hashPassword, verifyPassword } from "../worker/password";
import { verifyTurnstile } from "../worker/auth";
import { sendAccountEmail } from "../worker/email";
import { cleanupExpiredAuth } from "../worker/session-cleanup";
import type { SupportEnv } from "../worker/env";
import { testEnvironment } from "./helpers";

const PASSWORD = "a-strong-password-for-tests-only";
function fixture() {
    const value = testEnvironment();
    value.database.exec(readFileSync("migrations/0002_auth.sql", "utf8"));
    const messages: { to?: unknown; text?: string }[] = [];
    const env: SupportEnv = {
        ...value.env,
        QUOTA: Object.assign({} as SupportEnv["QUOTA"], value.env.QUOTA),
        BETTER_AUTH_SECRET: "only-for-tests-24c41d71-e740-4542-ad8c-12d206952f17",
        CF_MONITOR_TOKEN: "test-monitor-token", CF_API_TOKEN: "test-rule-token",
        AUTH_RATE_LIMIT: Object.assign({} as RateLimit, { limit: async () => ({ success: true }) }),
        EMAIL: Object.assign({} as SendEmail, { send: async (message: { text?: string }) => { messages.push(message); return { messageId: "test" }; } }),
        EMAIL_FROM: "noreply@vrclearn.com", ALERT_EMAIL: "", CF_ACCOUNT_ID: "", CF_ZONE_ID: "", EDGE_RULESET_ID: "", EDGE_RULE_ID: "", EDGE_MEDIA_RULE_ID: "",
        D1_DATABASE_ID: "", PAGES_PROJECT_NAME: "vrclearn-store", SUPPORT_SCRIPT_NAME: "vrclearn-store-support", PRIVATE_BUCKET_NAME: "private", PUBLIC_BUCKET_NAME: "public",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        if (String(input) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error("Unexpected external request");
        return Response.json({ success: true, hostname: "store.vrclearn.com", action: "auth" });
    }));
    const request = (path: string, body?: unknown, cookie?: string) => new Request(`https://store.vrclearn.com/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: env.ORIGIN, "content-type": "application/json", "x-turnstile-token": "test-token", "cf-connecting-ip": "203.0.113.5", ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = (response: Response) => response.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");
    return { ...value, env, messages, request, cookie };
}
afterEach(() => vi.unstubAllGlobals());

describe("native password security", () => {
    it("salts equal passwords and verifies only the explicit native scrypt format", async () => {
        const first = await hashPassword(PASSWORD);
        const second = await hashPassword(PASSWORD);
        expect(first).not.toBe(second);
        expect(await verifyPassword({ hash: first, password: PASSWORD })).toBe(true);
        expect(await verifyPassword({ hash: first, password: "incorrect" })).toBe(false);
        expect(await verifyPassword({ hash: first.replace("32768", "1073741824"), password: PASSWORD })).toBe(false);
    });
});

describe("email authentication and admin MFA", () => {
    it.each(["maintenance", "kv-failure"])("stops every account route for %s before rate limits, Turnstile or database work", async (state) => {
        const f = fixture();
        try {
            f.env.ENVIRONMENT = "production";
            if (state === "maintenance") f.state.set("budget:state", JSON.stringify({ mode: "maintenance", updatedAt: new Date().toISOString() }));
            else vi.spyOn(f.env.STATE, "get").mockRejectedValue(new Error("KV unavailable"));
            const rate = vi.spyOn(f.env.AUTH_RATE_LIMIT, "limit");
            const before = f.queries.length;
            for (const path of ["/get-session", "/list-sessions", "/verify-email", "/reset-password/arbitrary-token-0001"]) {
                const result = await handleAuth(f.request(path), f.env);
                expect(result.status, path).toBe(503);
                expect(result.headers.get("Retry-After"), path).toBe("60");
            }
            for (const path of ["/sign-in/email", "/sign-up/email", "/request-password-reset", "/reset-password", "/two-factor/verify-totp", "/change-password", "/sign-out"]) {
                expect((await handleAuth(f.request(path, {}), f.env)).status, path).toBe(503);
            }
            expect(rate).not.toHaveBeenCalled();
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(before);
            expect(f.messages).toHaveLength(0);
        } finally { f.database.close(); }
    });

    it("allows password login in restricted mode while blocking account email operations", async () => {
        const f = fixture();
        try {
            const email = "restricted@example.com";
            expect((await handleAuth(f.request("/sign-up/email", { name: "User", email, password: PASSWORD }), f.env)).status).toBe(200);
            await handleAuth(new Request(/https:\/\/[^\s]+/.exec(f.messages[0].text ?? "")![0]), f.env);
            f.env.ENVIRONMENT = "production";
            f.state.set("budget:state", JSON.stringify({ mode: "restricted", updatedAt: new Date().toISOString() }));
            expect((await handleAuth(f.request("/sign-in/email", { email, password: PASSWORD }), f.env)).status).toBe(200);
            const before = f.queries.length;
            for (const path of ["/sign-up/email", "/request-password-reset", "/send-verification-email"]) {
                const response = await handleAuth(f.request(path, { name: "Other", email, password: PASSWORD }), f.env);
                expect(response.status, path).toBe(503);
            }
            expect(f.queries).toHaveLength(before);
            expect(f.messages).toHaveLength(1);
        } finally { f.database.close(); }
    });

    it("blocks MFA secret exports and revokes pre-enrollment sessions while preserving backup-code login", async () => {
        const f = fixture();
        try {
            const email = "mfa-boundary@example.com";
            expect((await handleAuth(f.request("/sign-up/email", { name: "Admin", email, password: PASSWORD }), f.env)).status).toBe(200);
            const verificationUrl = /https:\/\/[^\s]+/.exec(f.messages[0].text ?? "")![0];
            await handleAuth(new Request(verificationUrl), f.env);
            const first = await handleAuth(f.request("/sign-in/email", { email, password: PASSWORD }), f.env);
            const other = await handleAuth(f.request("/sign-in/email", { email, password: PASSWORD }), f.env);
            const firstCookie = f.cookie(first);
            const otherCookie = f.cookie(other);
            const auth = createAuth(f.env);
            const user = await getSessionUser(auth, f.env, new Headers({ cookie: firstCookie }));
            f.database.prepare("INSERT INTO user_profiles(user_id,role,banned) VALUES(?,'admin',0)").run(user!.id);
            const enabled = await handleAuth(f.request("/two-factor/enable", { password: PASSWORD, method: "totp" }, firstCookie), f.env);
            expect(enabled.status).toBe(200);
            const setup = await enabled.json() as { totpURI: string; backupCodes: string[] };
            const code = await totp(new URL(setup.totpURI).searchParams.get("secret")!);
            const completed = await handleAuth(f.request("/two-factor/verify-totp", { code }, firstCookie), f.env);
            expect(completed.status).toBe(200);
            const secureCookie = f.cookie(completed) || firstCookie;

            for (const cookie of [otherCookie, secureCookie]) {
                for (const path of ["/two-factor/get-totp-uri", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri/", "/two-factor/%67et-totp-uri"]) {
                    const denied = await handleAuth(f.request(path, { password: PASSWORD }, cookie), f.env);
                    expect(denied.status, path).toBe(404);
                }
            }
            expect(await getSessionUser(auth, f.env, new Headers({ cookie: otherCookie }))).toBeNull();
            expect(await getSessionUser(auth, f.env, new Headers({ cookie: secureCookie }))).toMatchObject({ role: "admin", twoFactorVerified: true });

            const challenge = await handleAuth(f.request("/sign-in/email", { email, password: PASSWORD }), f.env);
            expect(await challenge.clone().json()).toMatchObject({ twoFactorRedirect: true });
            const recovered = await handleAuth(f.request("/two-factor/verify-backup-code", { code: setup.backupCodes[0] }, f.cookie(challenge)), f.env);
            expect(recovered.status, await recovered.clone().text()).toBe(200);
            expect(await getSessionUser(auth, f.env, new Headers({ cookie: f.cookie(recovered) }))).toMatchObject({ role: "admin", twoFactorVerified: true });
            expect(await getSessionUser(auth, f.env, new Headers({ cookie: secureCookie }))).toMatchObject({ twoFactorVerified: true });
        } finally { f.database.close(); }
    });

    it("shares the reset callback rate limit across arbitrary tokens before database lookups", async () => {
        const f = fixture();
        try {
            const buckets = new Map<string, number>();
            f.env.AUTH_RATE_LIMIT = Object.assign({} as RateLimit, { limit: async ({ key }: { key: string }) => {
                const count = (buckets.get(key) ?? 0) + 1;
                buckets.set(key, count);
                return { success: count <= 20 };
            } });
            const callback = encodeURIComponent(`${f.env.ORIGIN}/en/account?mode=reset`);
            for (let index = 0; index < 20; index++) {
                const response = await handleAuth(f.request(`/reset-password/fake-token-${index}?callbackURL=${callback}`), f.env);
                expect(response.status).toBe(302);
            }
            const before = f.queries.length;
            const denied = await handleAuth(f.request(`/reset-password/${"a".repeat(256)}?callbackURL=${callback}`), f.env);
            expect(denied.status).toBe(429);
            expect(f.queries).toHaveLength(before);
            expect(buckets.size).toBe(1);
            expect(f.queries.filter((query) => query.values.some((value) => typeof value === "string" && value.startsWith("reset-password:")))).toHaveLength(20);
            expect((await handleAuth(f.request("/reset-password", { token: "another-token", newPassword: PASSWORD }), f.env)).status).toBe(429);
            expect(f.queries).toHaveLength(before);
        } finally { f.database.close(); }
    });

    it("requires verified email, records session-specific MFA, and revokes it on sign-out", async () => {
        const f = fixture();
        const signUp = await handleAuth(f.request("/sign-up/email", { name: "Test", email: "test@example.com", password: PASSWORD }), f.env);
        expect(signUp.status, await signUp.clone().text()).toBe(200);
        expect(f.messages).toHaveLength(1);
        const denied = await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: PASSWORD }), f.env);
        expect(denied.status).toBe(403);
        const verificationUrl = /https:\/\/[^\s]+/.exec(f.messages[0].text ?? "")?.[0];
        expect(verificationUrl).toBeTruthy();
        const verified = await handleAuth(new Request(verificationUrl!), f.env);
        expect(verified.status).toBeLessThan(400);
        const signedIn = await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: PASSWORD }), f.env);
        expect(signedIn.status, await signedIn.clone().text()).toBe(200);
        const firstCookie = f.cookie(signedIn);
        const auth = createAuth(f.env);
        const current = await getSessionUser(auth, f.env, new Headers({ cookie: firstCookie }));
        expect(current?.emailVerified).toBe(true);
        expect(current?.twoFactorVerified).toBe(false);
        f.database.prepare("INSERT INTO user_profiles(user_id,role,banned) VALUES(?,'admin',0)").run(current!.id);
        const enabled = await handleAuth(f.request("/two-factor/enable", { password: PASSWORD, method: "totp" }, firstCookie), f.env);
        expect(enabled.status, await enabled.clone().text()).toBe(200);
        const setup = await enabled.json() as { totpURI: string };
        expect((await getSessionUser(auth, f.env, new Headers({ cookie: firstCookie })))?.twoFactorVerified).toBe(false);
        const token = await totp(new URL(setup.totpURI).searchParams.get("secret")!);
        const twoFactor = await handleAuth(f.request("/two-factor/verify-totp", { code: token }, firstCookie), f.env);
        expect(twoFactor.status, await twoFactor.clone().text()).toBe(200);
        const secureCookie = f.cookie(twoFactor) || firstCookie;
        expect(await getSessionUser(auth, f.env, new Headers({ cookie: secureCookie }))).toMatchObject({ role: "admin", twoFactorEnabled: true, twoFactorVerified: true });
        const disabling = await handleAuth(f.request("/two-factor/disable", { password: PASSWORD }, secureCookie), f.env);
        expect(disabling.status).toBe(403);
        await handleAuth(f.request("/sign-out", {}, secureCookie), f.env);
        expect(await getSessionUser(auth, f.env, new Headers({ cookie: secureCookie }))).toBeNull();
        const challenge = await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: PASSWORD }), f.env);
        expect(challenge.status).toBe(200);
        expect(await challenge.clone().json()).toMatchObject({ twoFactorRedirect: true });
        const challengeCookie = f.cookie(challenge);
        expect(await getSessionUser(auth, f.env, new Headers({ cookie: challengeCookie }))).toBeNull();
        const secondCode = await totp(new URL(setup.totpURI).searchParams.get("secret")!);
        const completed = await handleAuth(f.request("/two-factor/verify-totp", { code: secondCode }, challengeCookie), f.env);
        expect(completed.status, await completed.clone().text()).toBe(200);
        expect(await getSessionUser(auth, f.env, new Headers({ cookie: f.cookie(completed) }))).toMatchObject({ role: "admin", twoFactorVerified: true });
        const before = f.queries.length;
        expect(createAuth(f.env)).toBe(auth);
        await getSessionUser(createAuth(f.env), f.env, new Headers({ cookie: f.cookie(completed) }));
        expect(f.queries.slice(before).some((query) => /pragma|sqlite_master/i.test(query.sql))).toBe(false);
    });

    it("rejects challenges for another host or action and rejects cross-origin writes before hashing", async () => {
        const f = fixture();
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "attacker.example", action: "auth" })));
        expect(await verifyTurnstile(f.env, f.request("/sign-in/email", {}), "token")).toBe(false);
        const invalid = f.request("/sign-in/email", { email: "a@example.com", password: PASSWORD });
        invalid.headers.set("origin", "https://attacker.example");
        expect((await handleAuth(invalid, f.env)).status).toBe(403);
        expect(f.messages).toHaveLength(0);
    });

    it("uses a one-time reset link and revokes existing sessions after changing the password", async () => {
        const f = fixture();
        await handleAuth(f.request("/sign-up/email", { name: "Reset", email: "reset@example.com", password: PASSWORD }), f.env);
        const verificationUrl = /https:\/\/[^\s]+/.exec(f.messages[0].text ?? "")![0];
        await handleAuth(new Request(verificationUrl), f.env);
        const login = await handleAuth(f.request("/sign-in/email", { email: "reset@example.com", password: PASSWORD }), f.env);
        const oldCookie = f.cookie(login);
        const requested = await handleAuth(f.request("/request-password-reset", { email: "reset@example.com", redirectTo: `${f.env.ORIGIN}/en/account?mode=reset` }), f.env);
        expect(requested.status, await requested.clone().text()).toBe(200);
        const resetUrl = /https:\/\/[^\s]+/.exec(f.messages[1].text ?? "")![0];
        const redirect = await handleAuth(new Request(resetUrl), f.env);
        expect(redirect.status).toBe(302);
        const token = new URL(redirect.headers.get("location")!).searchParams.get("token");
        expect(token).toBeTruthy();
        const changed = await handleAuth(f.request("/reset-password", { token, newPassword: `${PASSWORD}-new` }), f.env);
        expect(changed.status, await changed.clone().text()).toBe(200);
        expect(await getSessionUser(createAuth(f.env), f.env, new Headers({ cookie: oldCookie }))).toBeNull();
        expect((await handleAuth(f.request("/reset-password", { token, newPassword: `${PASSWORD}-another` }), f.env)).status).toBeGreaterThanOrEqual(400);
        expect((await handleAuth(f.request("/sign-in/email", { email: "reset@example.com", password: `${PASSWORD}-new` }), f.env)).status).toBe(200);
    });

    it("does not send account emails with missing, malformed or stale production budget state", async () => {
        const f = fixture();
        f.env.ENVIRONMENT = "production";
        await expect(sendAccountEmail(f.env, "a@example.com", "Verify", `${f.env.ORIGIN}/verify`)).rejects.toThrow("EMAIL_PAUSED");
        f.state.set("budget:state", JSON.stringify({ mode: "normal", updatedAt: "not-a-date" }));
        await expect(sendAccountEmail(f.env, "a@example.com", "Verify", `${f.env.ORIGIN}/verify`)).rejects.toThrow("EMAIL_PAUSED");
        f.state.set("budget:state", JSON.stringify({ mode: "normal", updatedAt: new Date(Date.now() - 1_800_001).toISOString() }));
        await expect(sendAccountEmail(f.env, "a@example.com", "Verify", `${f.env.ORIGIN}/verify`)).rejects.toThrow("EMAIL_PAUSED");
        expect(f.messages).toHaveLength(0);
    });

    it.each([
        { status: 429, payload: { allowed: true }, code: "QUOTA_UNAVAILABLE" },
        { status: 200, payload: { allowed: false }, code: "QUOTA_UNAVAILABLE" },
        { status: 200, payload: { allowed: true, duplicate: true }, code: "QUOTA_UNAVAILABLE" },
        { status: 429, payload: { allowed: false, retryAfter: -1 }, code: "QUOTA_UNAVAILABLE" },
        { status: 429, payload: { allowed: false, duplicate: true, retryAfter: 60 }, code: "EMAIL_QUOTA_EXCEEDED" },
    ])("does not send email for inconsistent or denied quota responses %j", async ({ status, payload, code }) => {
        const f = fixture();
        try {
            f.env.ENVIRONMENT = "production";
            f.state.set("budget:state", JSON.stringify({ mode: "normal", updatedAt: new Date().toISOString() }));
            const fetch = vi.fn(async () => Response.json(payload, { status }));
            f.env.QUOTA = Object.assign({} as SupportEnv["QUOTA"], { getByName: () => ({ fetch }) });
            await expect(sendAccountEmail(f.env, "a@example.com", "Verify", `${f.env.ORIGIN}/verify`)).rejects.toThrow(code);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(f.messages).toHaveLength(0);
        } finally { f.database.close(); }
    });

    it("cleans only bounded batches of expired verification records", async () => {
        const f = fixture();
        const insert = f.database.prepare("INSERT INTO auth_verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)");
        const expired = new Date(Date.now() - 60_000).toISOString();
        for (let index = 0; index < 102; index++) insert.run(`expired-${index}`, `token-${index}`, "value", expired, expired, expired);
        const future = new Date(Date.now() + 60_000).toISOString();
        insert.run("active", "active-token", "value", future, expired, expired);
        await cleanupExpiredAuth(f.env);
        expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_verification").get()?.n).toBe(3);
        expect(f.database.prepare("SELECT id FROM auth_verification WHERE id='active'").get()?.id).toBe("active");
    });
});

async function totp(secret: string): Promise<string> {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const character of secret.toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
    const bytes = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const digest = createHmac("sha1", bytes).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
