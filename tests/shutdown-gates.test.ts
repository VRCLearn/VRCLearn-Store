import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/api/auth/[[path]]";
import { handleApi } from "../server/api";
import type { AppEnv } from "../server/env";
import { edgeRequest, testEnvironment } from "./helpers";

describe("application emergency stop", () => {
    it("stops every API branch, including config and private media, before other bindings", async () => {
        const f = testEnvironment();
        try {
            f.state.set("budget:state", JSON.stringify({ mode: "maintenance", updatedAt: new Date().toISOString() }));
            const auth = vi.spyOn(f.env.AUTH, "fetch");
            const media = vi.spyOn(f.env.PRIVATE_MEDIA, "get");
            const quota = vi.spyOn(f.env.QUOTA, "getByName");
            const before = f.queries.length;
            for (const path of ["config", "me", "products", "shops/test", "favorites", "merchant/workspace", "merchant/media/00000000-0000-4000-8000-000000000000", "admin/reviews"]) {
                const result = await handleApi(edgeRequest(`/api/v1/${path}`, { user: "merchant" }), f.env, { waitUntil: vi.fn() });
                expect(result.status, path).toBe(503);
                expect(result.headers.get("Cache-Control"), path).toBe("no-store");
            }
            expect(auth).not.toHaveBeenCalled();
            expect(media).not.toHaveBeenCalled();
            expect(quota).not.toHaveBeenCalled();
            expect(f.queries).toHaveLength(before);
        } finally { f.database.close(); }
    });
    it.each(["maintenance", "kv-failure"])("stops auth at Pages for %s before calling the support Worker", async (state) => {
        const f = testEnvironment();
        try {
            const auth = vi.spyOn(f.env.AUTH, "fetch");
            if (state === "maintenance") f.state.set("budget:state", JSON.stringify({ mode: "maintenance", updatedAt: new Date().toISOString() }));
            else vi.spyOn(f.env.STATE, "get").mockRejectedValue(new Error("KV unavailable"));
            const request = edgeRequest("/api/auth/sign-in/email", { method: "POST", body: { email: "user@example.com", password: "password" } });
            const context = Object.assign({} as EventContext<AppEnv, string, Record<string, unknown>>, { request, env: f.env });
            const result = await onRequest(context);
            expect(result.status).toBe(503);
            expect(result.headers.get("Cache-Control")).toBe("no-store");
            expect(result.headers.get("Retry-After")).toBe("60");
            expect(auth).not.toHaveBeenCalled();
        } finally { f.database.close(); }
    });
    it("forwards auth in restricted mode and still rejects an unapproved host", async () => {
        const f = testEnvironment();
        try {
            f.state.set("budget:state", JSON.stringify({ mode: "restricted", updatedAt: new Date().toISOString() }));
            const auth = vi.spyOn(f.env.AUTH, "fetch");
            const context = (request: Request) => Object.assign({} as EventContext<AppEnv, string, Record<string, unknown>>, { request, env: f.env });
            expect((await onRequest(context(edgeRequest("/api/auth/get-session")))).status).toBe(200);
            expect(auth).toHaveBeenCalledTimes(1);
            expect((await onRequest(context(new Request("https://preview.pages.dev/api/auth/get-session")))).status).toBe(404);
            expect(auth).toHaveBeenCalledTimes(1);
        } finally { f.database.close(); }
    });
});
