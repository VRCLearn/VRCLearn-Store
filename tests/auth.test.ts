import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth, getSessionUser, handleAuth, verifyTurnstile } from "../worker/auth";
import { hashPassword, verifyPassword } from "../worker/password";
import { reserve } from "../worker/quota-client";
import { cleanupExpiredAuth } from "../worker/session-cleanup";
import type { SupportEnv } from "../worker/env";
import { testEnvironment } from "./helpers";

const PASSWORD = "a-strong-password-for-tests-only";
function fixture() {
    const value = testEnvironment();
    const env: SupportEnv = {
        ...value.env,
        QUOTA: Object.assign({} as SupportEnv["QUOTA"], value.env.QUOTA),
        BETTER_AUTH_SECRET: "only-for-tests-24c41d71-e740-4542-ad8c-12d206952f17",
        AUTH_RATE_LIMIT: Object.assign({} as RateLimit, { limit: async () => ({ success: true }) }),
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
    const signUp = (email = "test@example.com") => handleAuth(request("/sign-up/email", { name: "Display nickname", email, password: PASSWORD }), env);
    const session = (cookie: string) => getSessionUser(createAuth(env), env, new Headers({ cookie }));
    return { ...value, env, request, cookie, signUp, session };
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

describe("temporary email and password accounts", () => {
    it("registers and signs in immediately without claiming email ownership or sending account email", async () => {
        const f = fixture();
        try {
            const response = await handleAuth(f.request("/sign-up/email", { name: "Display nickname", email: "test@example.com", password: PASSWORD, emailVerified: true, role: "admin" }), f.env);
            expect(response.status, await response.clone().text()).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            const session = await f.session(f.cookie(response));
            expect(session).toMatchObject({ email: "test@example.com", name: "Display nickname", role: "user", banned: false });
            expect(session).not.toHaveProperty("emailVerified");
            expect(session).not.toHaveProperty("twoFactorEnabled");
            expect(f.database.prepare("SELECT emailVerified FROM auth_user").get()?.emailVerified).toBe(0);
            expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_verification").get()?.n).toBe(0);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            expect(globalThis.fetch).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.any(Object));
            expect(createAuth(f.env)).toBe(createAuth(f.env));
        } finally { f.database.close(); }
    });

    it("reads administrator and ban status by user ID and revokes the session on sign-out", async () => {
        const f = fixture();
        try {
            const response = await f.signUp();
            const cookie = f.cookie(response);
            const current = await f.session(cookie);
            f.database.prepare("INSERT INTO user_profiles(user_id,role,banned) VALUES(?,'admin',0)").run(current!.id);
            expect(await f.session(cookie)).toMatchObject({ role: "admin", banned: false });
            f.database.prepare("UPDATE user_profiles SET banned=1 WHERE user_id=?").run(current!.id);
            expect(await f.session(cookie)).toMatchObject({ role: "admin", banned: true });
            const before = f.queries.length;
            await f.session(cookie);
            expect(f.queries.slice(before).some((query) => /pragma|sqlite_master/i.test(query.sql))).toBe(false);
            expect((await handleAuth(f.request("/sign-out", {}, cookie), f.env)).status).toBe(200);
            expect(await f.session(cookie)).toBeNull();
        } finally { f.database.close(); }
    });

    it.each(["user", "admin"] as const)("updates only the display profile without changing the %s role or email ownership", async (role) => {
        const f = fixture();
        try {
            const response = await f.signUp();
            const cookie = f.cookie(response);
            const current = await f.session(cookie);
            f.database.prepare("INSERT INTO user_profiles(user_id,role,banned) VALUES(?,?,0)").run(current!.id, role);
            const updated = await handleAuth(f.request("/update-user", {
                name: "Updated nickname", role: role === "user" ? "admin" : "user", banned: true,
                emailVerified: true, id: "another-user", userId: "another-user",
            }, cookie), f.env);
            expect(updated.status, await updated.clone().text()).toBe(200);
            expect(await f.session(cookie)).toMatchObject({ id: current!.id, name: "Updated nickname", role, banned: false });
            expect(f.database.prepare("SELECT id,email,emailVerified FROM auth_user").get()).toEqual({ id: current!.id, email: "test@example.com", emailVerified: 0 });
            expect(f.database.prepare("SELECT role,banned FROM user_profiles WHERE user_id=?").get(current!.id)).toEqual({ role, banned: 0 });
            const changedEmail = await handleAuth(f.request("/update-user", { email: "different@example.com" }, cookie), f.env);
            expect(changedEmail.status).toBe(400);
            expect(f.database.prepare("SELECT email FROM auth_user").get()?.email).toBe("test@example.com");
        } finally { f.database.close(); }
    });

    it("requires the current password and revokes other sessions even when the client opts out", async () => {
        const f = fixture();
        try {
            const first = await f.signUp();
            const firstCookie = f.cookie(first);
            const other = await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: PASSWORD }), f.env);
            const otherCookie = f.cookie(other);
            const rejected = await handleAuth(f.request("/change-password", { currentPassword: "incorrect-password", newPassword: `${PASSWORD}-new` }, firstCookie), f.env);
            expect(rejected.status).toBe(400);
            expect(await f.session(otherCookie)).not.toBeNull();
            const changed = await handleAuth(f.request("/change-password", { currentPassword: PASSWORD, newPassword: `${PASSWORD}-new`, revokeOtherSessions: false }, firstCookie), f.env);
            expect(changed.status, await changed.clone().text()).toBe(200);
            expect(await f.session(otherCookie)).toBeNull();
            expect(await f.session(firstCookie)).toBeNull();
            expect(await f.session(f.cookie(changed))).not.toBeNull();
            expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_session").get()?.n).toBe(1);
            expect((await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: PASSWORD }), f.env)).status).toBe(401);
            expect((await handleAuth(f.request("/sign-in/email", { email: "test@example.com", password: `${PASSWORD}-new` }), f.env)).status).toBe(200);
        } finally { f.database.close(); }
    });

    it("requires a session to change a password and retains host-scoped secure cookies", async () => {
        const f = fixture();
        try {
            f.env.ENVIRONMENT = "production";
            const rejected = await handleAuth(f.request("/change-password", { currentPassword: PASSWORD, newPassword: `${PASSWORD}-new` }), f.env);
            expect(rejected.status).toBe(401);
            const signedUp = await f.signUp();
            const cookie = signedUp.headers.getSetCookie().find((value) => value.includes("session_token"));
            expect(cookie).toMatch(/HttpOnly/i);
            expect(cookie).toMatch(/Secure/i);
            expect(cookie).toMatch(/SameSite=Lax/i);
            expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
        } finally { f.database.close(); }
    });

    it.each([
        "/send-verification-email", "/verify-email", "/request-password-reset", "/reset-password", "/reset-password/old-token-0001",
        "/two-factor/enable", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/change-email",
    ])("rejects removed endpoint %s before rate limits or database access", async (path) => {
        const f = fixture();
        try {
            const rate = vi.spyOn(f.env.AUTH_RATE_LIMIT, "limit");
            const before = f.queries.length;
            for (const body of [undefined, { token: "old-token", newPassword: PASSWORD }]) {
                expect((await handleAuth(f.request(path, body), f.env)).status).toBe(404);
            }
            expect(rate).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(before);
            expect(globalThis.fetch).not.toHaveBeenCalled();
        } finally { f.database.close(); }
    });

    it.each([
        ["/get-session", "POST", "GET"], ["/list-sessions", "POST", "GET"],
        ["/sign-up/email", "GET", "POST"], ["/sign-in/email", "HEAD", "POST"],
        ["/sign-out", "GET", "POST"], ["/change-password", "GET", "POST"],
        ["/update-user", "GET", "POST"], ["/revoke-sessions", "DELETE", "POST"],
        ["/revoke-session", "GET", "POST"], ["/revoke-other-sessions", "GET", "POST"],
    ])("rejects method %s %s before authentication work", async (path, method, allowed) => {
        const f = fixture();
        try {
            const rate = vi.spyOn(f.env.AUTH_RATE_LIMIT, "limit");
            const response = await handleAuth(new Request(`${f.env.ORIGIN}/api/auth${path}`, { method }), f.env);
            expect(response.status).toBe(405);
            expect(response.headers.get("Allow")).toBe(allowed);
            expect(rate).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(0);
            expect(globalThis.fetch).not.toHaveBeenCalled();
        } finally { f.database.close(); }
    });

    it("rejects cross-origin writes and missing production client addresses before expensive work", async () => {
        const f = fixture();
        try {
            f.env.ENVIRONMENT = "production";
            const invalidOrigin = f.request("/sign-up/email", { email: "a@example.com", name: "A", password: PASSWORD });
            invalidOrigin.headers.set("origin", "https://attacker.example");
            const missingIp = f.request("/sign-up/email", { email: "a@example.com", name: "A", password: PASSWORD });
            missingIp.headers.delete("cf-connecting-ip");
            expect((await handleAuth(invalidOrigin, f.env)).status).toBe(403);
            expect((await handleAuth(missingIp, f.env)).status).toBe(403);
            expect(f.queries).toHaveLength(0);
            expect(globalThis.fetch).not.toHaveBeenCalled();
        } finally { f.database.close(); }
    });

    it("binds human verification to the correct hostname and action", async () => {
        const f = fixture();
        try {
            vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "attacker.example", action: "auth" })));
            expect(await verifyTurnstile(f.env, f.request("/sign-in/email", {}), "token")).toBe(false);
            vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "store.vrclearn.com", action: "upload" })));
            expect(await verifyTurnstile(f.env, f.request("/sign-in/email", {}), "token")).toBe(false);
            expect((await f.signUp()).status).toBe(403);
            expect(f.queries).toHaveLength(0);
        } finally { f.database.close(); }
    });

    it("stops registration at the atomic account quota before password hashing or database work", async () => {
        const f = fixture();
        try {
            const calls: { key: string; limits: { key: string; limit: number }[] }[] = [];
            f.env.QUOTA = Object.assign({} as SupportEnv["QUOTA"], { getByName: () => ({ fetch: async (request: Request) => {
                calls.push(await request.json());
                return Response.json({ allowed: false, retryAfter: 42 }, { status: 429 });
            } }) });
            const response = await f.signUp("normalized@example.com");
            expect(response.status).toBe(429);
            expect(response.headers.get("Retry-After")).toBe("42");
            expect(calls).toHaveLength(1);
            expect(calls[0].limits).toHaveLength(3);
            expect(calls[0].limits.map((limit) => limit.limit)).toEqual([10, 5, 20]);
            expect(JSON.stringify(calls)).not.toContain("normalized@example.com");
            expect(f.queries).toHaveLength(0);
        } finally { f.database.close(); }
    });

    it("rejects oversized registration bodies before human verification or database work", async () => {
        const f = fixture();
        try {
            const response = await handleAuth(f.request("/sign-up/email", { email: "a@example.com", name: "x".repeat(17000), password: PASSWORD }), f.env);
            expect(response.status).toBe(413);
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(0);
        } finally { f.database.close(); }
    });
});

describe("atomic authentication quota client", () => {
    it.each([
        { status: 429, payload: { allowed: true } },
        { status: 200, payload: { allowed: false } },
        { status: 200, payload: { allowed: true, duplicate: true } },
        { status: 429, payload: { allowed: false, retryAfter: -1 } },
        { status: 503, payload: { allowed: false } },
    ])("fails closed for an inconsistent quota response %j", async ({ status, payload }) => {
        const fetch = vi.fn(async () => Response.json(payload, { status }));
        const env = { QUOTA: Object.assign({} as SupportEnv["QUOTA"], { getByName: () => ({ fetch }) }) };
        await expect(reserve(env, "auth:operation", [{ key: "auth:test", limit: 1, windowSeconds: 60 }])).rejects.toThrow("QUOTA_UNAVAILABLE");
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe("bounded authentication cleanup", () => {
    it("cleans only fixed batches of expired records while retaining active sessions and accounts", async () => {
        const f = fixture();
        try {
            const expired = new Date(Date.now() - 60_000).toISOString();
            const future = new Date(Date.now() + 60_000).toISOString();
            const insert = f.database.prepare("INSERT INTO auth_verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)");
            for (let index = 0; index < 102; index++) insert.run(`expired-${index}`, `token-${index}`, "value", expired, expired, expired);
            insert.run("active", "active-token", "value", future, expired, expired);
            f.database.prepare("INSERT INTO auth_user(id,name,email,createdAt,updatedAt) VALUES('cleanup-user','User','cleanup@example.com',?,?)").run(expired, expired);
            const sessions = f.database.prepare("INSERT INTO auth_session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,'cleanup-user',?,?,?)");
            for (let index = 0; index < 102; index++) sessions.run(`expired-${index}`, `session-${index}`, expired, expired, expired);
            sessions.run("active", "active-session", future, expired, expired);
            await cleanupExpiredAuth(f.env);
            expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_verification").get()?.n).toBe(3);
            expect(f.database.prepare("SELECT id FROM auth_verification WHERE id='active'").get()?.id).toBe("active");
            expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_session").get()?.n).toBe(3);
            expect(f.database.prepare("SELECT id FROM auth_session WHERE id='active'").get()?.id).toBe("active");
            expect(f.database.prepare("SELECT COUNT(*) AS n FROM auth_user").get()?.n).toBe(1);
        } finally { f.database.close(); }
    });
});
