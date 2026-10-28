import { betterAuth } from "better-auth";
import type { SessionUser } from "../shared/contracts";
import type { SupportEnv } from "./env";
import { sendAccountEmail, reserve, accountEmailsEnabled } from "./email";
import { authFailure, digestKey, readBounded } from "./http";
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
    return {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
        role: profile?.role === "admin" ? "admin" : "user",
        banned: Boolean(profile?.banned),
    };
}

const TOKEN_PATHS = new Set(["/sign-up/email", "/sign-in/email", "/request-password-reset", "/send-verification-email"]);
const AUTH_PATHS = new Set([
    ...TOKEN_PATHS, "/verify-email", "/reset-password", "/get-session", "/sign-out",
    "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions", "/change-password", "/update-user",
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
    if (!await serviceEnabled(env)) return authFailure("SERVICE_PAUSED", "Account operations are temporarily paused", 503, 60);
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/auth".length);
    const passwordResetLink = request.method === "GET" && /^\/reset-password\/[A-Za-z0-9_-]{8,256}$/.test(path);
    if ((!AUTH_PATHS.has(path) && !passwordResetLink) || !["GET", "POST"].includes(request.method)) return authFailure("NOT_FOUND", "Endpoint not found", 404);
    if (request.method === "POST" && request.headers.get("origin") !== env.ORIGIN) return authFailure("INVALID_ORIGIN", "Origin rejected", 403);
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip && env.ENVIRONMENT === "production") return authFailure("IP_UNAVAILABLE", "Trusted client address is missing", 403);
    const ipKey = await digestKey(ip ?? "local");
    const operation = passwordResetLink ? "/reset-password" : path;
    if (!(await env.AUTH_RATE_LIMIT.limit({ key: `${ipKey}:${operation}` })).success) return authFailure("RATE_LIMITED", "Please try again later", 429, 60);
    let data: Record<string, unknown> = {};
    let forwarded = request;
    if (request.method === "POST") {
        const raw = await readBounded(request, 16384);
        if (raw === null) return authFailure("PAYLOAD_TOO_LARGE", "Request exceeds limit", 413);
        try {
            const input: unknown = JSON.parse(raw || "{}");
            if (!input || typeof input !== "object" || Array.isArray(input)) return authFailure("INVALID_JSON", "Object required", 400);
            data = input as Record<string, unknown>;
        } catch { return authFailure("INVALID_JSON", "Invalid JSON", 400); }
        if (TOKEN_PATHS.has(path)) {
            if (path !== "/sign-in/email" && !await accountEmailsEnabled(env)) {
                return authFailure("FEATURE_PAUSED", "Account email operations are temporarily paused", 503);
            }
            if (!await verifyTurnstile(env, request, request.headers.get("x-turnstile-token") ?? data.turnstileToken)) return authFailure("CHALLENGE_FAILED", "Verification failed", 403);
            if (typeof data.email === "string") {
                const emailKey = await digestKey(data.email.trim().toLowerCase());
                const limit = await reserve(env, `auth:${crypto.randomUUID()}`, [
                    { key: `auth:ip:${ipKey}`, limit: 10, windowSeconds: 60 },
                    { key: `auth:account:${emailKey}`, limit: 5, windowSeconds: 60 },
                    { key: `auth:account:hour:${emailKey}`, limit: 20, windowSeconds: 3600 },
                ]);
                if (!limit.allowed) return authFailure("RATE_LIMITED", "Please try again later", 429, limit.retryAfter);
            }
        }
        const headers = new Headers(request.headers);
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
        forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(data) });
    }
    const auth = createAuth(env);
    const result = await auth.handler(forwarded);
    const headers = new Headers(result.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(result.body, { status: result.status, headers });
}
