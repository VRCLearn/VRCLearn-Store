import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { createAuth, getSessionUser, handleAuth } from "../worker/auth";
import type { BudgetMode } from "../edge/budget";
import { cleanupStaleMedia } from "../edge/cleanup";
import { cleanupExpiredAuth } from "../worker/session-cleanup";
import type { SupportEnv } from "../worker/env";

vi.mock("../worker/quota", () => ({ QuotaGate: class {} }));
vi.mock("../worker/auth", () => ({ createAuth: vi.fn(() => ({})), getSessionUser: vi.fn(async () => null), handleAuth: vi.fn() }));
vi.mock("../edge/cleanup", () => ({ cleanupStaleMedia: vi.fn(async () => undefined) }));
vi.mock("../worker/session-cleanup", () => ({ cleanupExpiredAuth: vi.fn(async () => undefined) }));

function environment(mode: BudgetMode) {
    return Object.assign({} as SupportEnv, {
        ENVIRONMENT: "production",
        STATE: Object.assign({} as KVNamespace, { get: vi.fn(async () => ({ mode, updatedAt: new Date().toISOString() })) }),
    });
}
async function scheduled(env: SupportEnv) {
    const pending: Promise<unknown>[] = [];
    const ctx = Object.assign({} as ExecutionContext, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await worker.scheduled(Object.assign({} as ScheduledController), env, ctx);
    await Promise.all(pending);
}

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("support Worker emergency stop", () => {
    it("returns client-readable auth failures without changing internal API failures", async () => {
        const env = environment("normal");
        vi.mocked(handleAuth).mockRejectedValueOnce(new Error("Authentication binding failed"));
        const response = await worker.fetch(new Request("https://support.internal/api/auth/sign-in/email"), env);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "SERVICE_UNAVAILABLE", message: expect.any(String), requestId: response.headers.get("X-Request-ID") });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        vi.mocked(getSessionUser).mockRejectedValueOnce(new Error("Session database unavailable"));
        const internal = await worker.fetch(new Request("https://support.internal/internal/session"), env);
        expect(await internal.json()).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: expect.any(String), requestId: expect.any(String) } });
    });
    it.each(["maintenance", "kv-failure"])("rejects internal session requests on %s before auth or D1", async (mode) => {
        const env = environment("maintenance");
        if (mode === "kv-failure") vi.spyOn(env.STATE, "get").mockRejectedValue(new Error("KV unavailable"));
        const response = await worker.fetch(new Request("https://support.internal/internal/session"), env);
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(createAuth).not.toHaveBeenCalled();
        expect(getSessionUser).not.toHaveBeenCalled();
    });
    it("allows session checks in restricted mode", async () => {
        const env = environment("restricted");
        const response = await worker.fetch(new Request("https://support.internal/internal/session"), env);
        expect(response.status).toBe(200);
        expect(await response.json()).toBeNull();
        expect(createAuth).toHaveBeenCalledTimes(1);
        expect(getSessionUser).toHaveBeenCalledTimes(1);
    });
    it("skips scheduled nonessential cleanup during maintenance", async () => {
        await scheduled(environment("maintenance"));
        expect(cleanupStaleMedia).not.toHaveBeenCalled();
        expect(cleanupExpiredAuth).not.toHaveBeenCalled();
    });
    it("skips cleanup if local budget reads fail", async () => {
        const env = environment("normal");
        vi.spyOn(env.STATE, "get").mockRejectedValue(new Error("Local state unavailable"));
        await scheduled(env);
        expect(cleanupStaleMedia).not.toHaveBeenCalled();
        expect(cleanupExpiredAuth).not.toHaveBeenCalled();
    });
    it.each(["normal", "restricted"] as const)("runs one cleanup batch in %s mode", async (mode) => {
        await scheduled(environment(mode));
        expect(cleanupStaleMedia).toHaveBeenCalledTimes(1);
        expect(cleanupExpiredAuth).toHaveBeenCalledTimes(1);
    });
    it("does not retry a failed cleanup batch and still handles the other bounded cleanup", async () => {
        vi.mocked(cleanupStaleMedia).mockRejectedValueOnce(new Error("R2 unavailable"));
        await scheduled(environment("normal"));
        expect(cleanupStaleMedia).toHaveBeenCalledTimes(1);
        expect(cleanupExpiredAuth).toHaveBeenCalledTimes(1);
    });
});
