import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { createAuth, getSessionUser, handleAuth } from "../worker/auth";
import { cleanupStaleMedia } from "../edge/cleanup";
import { cleanupExpiredAuth } from "../worker/session-cleanup";
import type { SupportEnv } from "../worker/env";

vi.mock("../worker/quota", () => ({ QuotaGate: class {} }));
vi.mock("../worker/auth", () => ({ createAuth: vi.fn(() => ({})), getSessionUser: vi.fn(async () => null), handleAuth: vi.fn() }));
vi.mock("../edge/cleanup", () => ({ cleanupStaleMedia: vi.fn(async () => undefined) }));
vi.mock("../worker/session-cleanup", () => ({ cleanupExpiredAuth: vi.fn(async () => undefined) }));

function environment() {
    return Object.assign({} as SupportEnv, { ENVIRONMENT: "production" });
}
async function scheduled(env: SupportEnv) {
    const pending: Promise<unknown>[] = [];
    const ctx = Object.assign({} as ExecutionContext, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await worker.scheduled(Object.assign({} as ScheduledController), env, ctx);
    await Promise.all(pending);
}

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("internal account and cleanup Worker", () => {
    it("returns client-readable auth failures without changing internal API failures or leaking details", async () => {
        const env = environment();
        vi.mocked(handleAuth).mockRejectedValueOnce(new Error("Authentication binding failed"));
        const response = await worker.fetch(new Request("https://support.internal/api/auth/sign-in/email"), env);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "SERVICE_UNAVAILABLE", message: expect.any(String), requestId: response.headers.get("X-Request-ID") });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        vi.mocked(getSessionUser).mockRejectedValueOnce(new Error("Session database unavailable"));
        const internal = await worker.fetch(new Request("https://support.internal/internal/session"), env);
        expect(await internal.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: expect.any(String), requestId: expect.any(String) } });
        expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "support_request_failed" }));
    });

    it("serves internal session checks without a budget or email binding", async () => {
        const response = await worker.fetch(new Request("https://support.internal/internal/session"), environment());
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toBeNull();
        expect(createAuth).toHaveBeenCalledTimes(1);
        expect(getSessionUser).toHaveBeenCalledTimes(1);
    });

    it("rejects unknown internal paths and wrong session methods before account work", async () => {
        for (const [url, method] of [
            ["https://support.internal/internal/session", "POST"],
            ["https://support.internal/other", "GET"],
        ]) expect((await worker.fetch(new Request(url, { method }), environment())).status).toBe(404);
        expect(createAuth).not.toHaveBeenCalled();
        expect(getSessionUser).not.toHaveBeenCalled();
        expect(handleAuth).not.toHaveBeenCalled();
    });

    it("runs one bounded cleanup batch without account budget dependencies", async () => {
        await scheduled(environment());
        expect(cleanupStaleMedia).toHaveBeenCalledTimes(1);
        expect(cleanupExpiredAuth).toHaveBeenCalledTimes(1);
    });

    it("does not retry a failed cleanup batch and still handles the other bounded cleanup", async () => {
        vi.mocked(cleanupStaleMedia).mockRejectedValueOnce(new Error("R2 unavailable"));
        await scheduled(environment());
        expect(cleanupStaleMedia).toHaveBeenCalledTimes(1);
        expect(cleanupExpiredAuth).toHaveBeenCalledTimes(1);
    });
});
