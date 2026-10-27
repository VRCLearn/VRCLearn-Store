import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { SessionUser } from "../shared/contracts";
import type { SupportEnv } from "./env";
import { sendAccountEmail, reserve, accountEmailsEnabled } from "./email";
import { digestKey, failure, readBounded } from "./http";
import { hashPassword, verifyPassword } from "./password";
import { serviceEnabled } from "../edge/budget";

function buildAuth(env: SupportEnv) {
    if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET_NOT_CONFIGURED");
    return betterAuth({
        appName: "VRCLearn Store",
        baseURL: env.ORIGIN,
        basePath: "/api/auth",
        secret: env.BETTER_AUTH_SECRET,
        trustedOrigins: [env.ORIGIN],
        database: env.DB,
        user: { modelName: "auth_user" },
        account: { modelName: "auth_account", accountLinking: { enabled: false } },
        session: { modelName: "auth_session", expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } },
        verification: { modelName: "auth_verification" },
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            autoSignIn: false,
            minPasswordLength: 12,
            maxPasswordLength: 128,
            resetPasswordTokenExpiresIn: 1800,
            revokeSessionsOnPasswordReset: true,
            password: { hash: hashPassword, verify: verifyPassword },
            sendResetPassword: async ({ user, url }) => sendAccountEmail(env, user.email, "Reset your VRCLearn Store password", url),
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: false,
            autoSignInAfterVerification: false,
            expiresIn: 3600,
            sendVerificationEmail: async ({ user, url }) => sendAccountEmail(env, user.email, "Verify your VRCLearn Store email", url),
        },
        rateLimit: { enabled: false },
        advanced: {
            useSecureCookies: env.ENVIRONMENT === "production",
            defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: env.ENVIRONMENT === "production" },
            ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
        },
        plugins: [twoFactor({
            issuer: "VRCLearn Store",
            skipVerificationOnEnable: false,
            schema: { twoFactor: { modelName: "auth_two_factor" } },
        })],
    });
}

type Auth = ReturnType<typeof buildAuth>;
// Immutable service configuration can be reused. User/session/request objects are
// created by Better Auth per call and are never stored here.
const authServices = new WeakMap<D1Database, { signature: string; state: KVNamespace; email: SendEmail; quota: SupportEnv["QUOTA"]; auth: Auth }>();
export function createAuth(env: SupportEnv): Auth {
    const signature = JSON.stringify([env.ORIGIN, env.ENVIRONMENT, env.BETTER_AUTH_SECRET, env.EMAIL_FROM]);
    const cached = authServices.get(env.DB);
    if (cached && cached.signature === signature && cached.state === env.STATE && cached.email === env.EMAIL && cached.quota === env.QUOTA) return cached.auth;
    const auth = buildAuth(env);
    authServices.set(env.DB, { signature, state: env.STATE, email: env.EMAIL, quota: env.QUOTA, auth });
    return auth;
}
interface UserProfile { role: string; banned: number }

export async function getSessionUser(auth: Auth, env: SupportEnv, headers: Headers): Promise<SessionUser | null> {
    const result = await auth.api.getSession({ headers });
    if (!result) return null;
    const profile = await env.DB.prepare("SELECT role,banned FROM user_profiles WHERE user_id = ?").bind(result.user.id).first<UserProfile>();
    const proof = await env.DB.prepare("SELECT session_id FROM auth_mfa_sessions WHERE session_id = ? AND expires_at > ?")
        .bind(result.session.id, Date.now()).first<{ session_id: string }>();
    return {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
        role: profile?.role === "admin" ? "admin" : "user",
        banned: Boolean(profile?.banned),
        twoFactorEnabled: Boolean(result.user.twoFactorEnabled),
        twoFactorVerified: Boolean(result.user.twoFactorEnabled && proof),
    };
}

const TOKEN_PATHS = new Set(["/sign-up/email", "/sign-in/email", "/request-password-reset", "/send-verification-email"]);
const MFA_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const AUTH_PATHS = new Set([
    ...TOKEN_PATHS, ...MFA_PATHS, "/verify-email", "/reset-password", "/get-session", "/sign-out",
    "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions", "/change-password", "/update-user",
    "/two-factor/enable", "/two-factor/disable",
]);

export async function verifyTurnstile(env: SupportEnv, request: Request, token: unknown): Promise<boolean> {
    if (typeof token !== "string" || token.length < 1 || token.length > 2048 || !env.TURNSTILE_SECRET_KEY) return false;
    const form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET_KEY);
    form.set("response", token);
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) form.set("remoteip", ip);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", body: form, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result: { success?: boolean; hostname?: string; action?: string } = await response.json();
    return result.success === true && result.hostname === new URL(env.ORIGIN).hostname && result.action === "auth";
}

export async function handleAuth(request: Request, env: SupportEnv): Promise<Response> {
    if (!await serviceEnabled(env)) return failure("SERVICE_PAUSED", "Account operations are temporarily paused", 503, 60);
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/auth".length);
    const passwordResetLink = request.method === "GET" && /^\/reset-password\/[A-Za-z0-9_-]{8,256}$/.test(path);
    if ((!AUTH_PATHS.has(path) && !passwordResetLink) || !["GET", "POST"].includes(request.method)) return failure("NOT_FOUND", "Endpoint not found", 404);
    if (request.method === "POST" && request.headers.get("origin") !== env.ORIGIN) return failure("INVALID_ORIGIN", "Origin rejected", 403);
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip && env.ENVIRONMENT === "production") return failure("IP_UNAVAILABLE", "Trusted client address is missing", 403);
    const ipKey = await digestKey(ip ?? "local");
    const operation = passwordResetLink ? "/reset-password" : path;
    if (!(await env.AUTH_RATE_LIMIT.limit({ key: `${ipKey}:${operation}` })).success) return failure("RATE_LIMITED", "Please try again later", 429, 60);
    let data: Record<string, unknown> = {};
    let forwarded = request;
    if (request.method === "POST") {
        const raw = await readBounded(request, 16384);
        if (raw === null) return failure("PAYLOAD_TOO_LARGE", "Request exceeds limit", 413);
        try {
            const input: unknown = JSON.parse(raw || "{}");
            if (!input || typeof input !== "object" || Array.isArray(input)) return failure("INVALID_JSON", "Object required", 400);
            data = input as Record<string, unknown>;
        } catch { return failure("INVALID_JSON", "Invalid JSON", 400); }
        if (TOKEN_PATHS.has(path)) {
            if (path !== "/sign-in/email" && !await accountEmailsEnabled(env)) {
                return failure("FEATURE_PAUSED", "Account email operations are temporarily paused", 503);
            }
            if (!await verifyTurnstile(env, request, request.headers.get("x-turnstile-token") ?? data.turnstileToken)) return failure("CHALLENGE_FAILED", "Verification failed", 403);
            if (typeof data.email === "string") {
                const emailKey = await digestKey(data.email.trim().toLowerCase());
                const limit = await reserve(env, `auth:${crypto.randomUUID()}`, [
                    { key: `auth:ip:${ipKey}`, limit: 10, windowSeconds: 60 },
                    { key: `auth:account:${emailKey}`, limit: 5, windowSeconds: 60 },
                    { key: `auth:account:hour:${emailKey}`, limit: 20, windowSeconds: 3600 },
                ]);
                if (!limit.allowed) return failure("RATE_LIMITED", "Please try again later", 429, limit.retryAfter);
            }
        }
        // Admin sessions must prove MFA on this session; no trusted-device shortcut.
        if (MFA_PATHS.has(path)) { data.trustDevice = false; data.disableSession = false; }
        const headers = new Headers(request.headers);
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
        forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(data) });
    }
    const auth = createAuth(env);
    if (path === "/two-factor/disable") {
        const current = await getSessionUser(auth, env, request.headers);
        if (current?.role === "admin") return failure("ADMIN_MFA_REQUIRED", "Administrators cannot disable MFA", 403);
    }
    const beforeVerification = MFA_PATHS.has(path) ? await auth.api.getSession({ headers: request.headers }) : null;
    const result = await auth.handler(forwarded);
    if (result.ok && MFA_PATHS.has(path)) {
        const cookies = new Map<string, string>();
        for (const part of (request.headers.get("cookie") ?? "").split(";")) {
            const index = part.indexOf("=");
            if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1));
        }
        for (const part of result.headers.getSetCookie()) {
            const first = part.split(";")[0];
            const index = first.indexOf("=");
            if (index > 0) cookies.set(first.slice(0, index).trim(), first.slice(index + 1));
        }
        const proofHeaders = new Headers(request.headers);
        proofHeaders.set("cookie", Array.from(cookies, ([key, value]) => `${key}=${value}`).join("; "));
        const session = await auth.api.getSession({ headers: proofHeaders });
        if (session?.user.twoFactorEnabled) {
            const statements: D1PreparedStatement[] = [];
            // MFA activation invalidates sessions established with only a password.
            // Later challenge logins leave other MFA-verified sessions intact.
            if (beforeVerification && !beforeVerification.user.twoFactorEnabled && beforeVerification.user.id === session.user.id) {
                statements.push(env.DB.prepare("DELETE FROM auth_session WHERE userId = ? AND id != ?").bind(session.user.id, session.session.id));
            }
            statements.push(env.DB.prepare("INSERT INTO auth_mfa_sessions(session_id,user_id,expires_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET expires_at=excluded.expires_at")
                .bind(session.session.id, session.user.id, new Date(session.session.expiresAt).getTime()));
            await env.DB.batch(statements);
        }
    }
    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(result.body, { status: result.status, headers });
}
