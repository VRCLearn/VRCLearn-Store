import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { escapeHtml, safeJson, safeMarkdown } from "../edge/html";
import app from "../app/index";
import type { AppEnv } from "../server/env";

describe("static routing and safe detail output", () => {
    it.each([
        "/unknown", "/assets/missing.js", "/en/products/one/extra", "/en/products/", "/de/products/one", "/sitemaps/nope.xml", "/en/reset-password", "/api/auth", "/api/v2/products",
        "/api/v1", "/api/v1/", "/api/v1/not-a-route", "/api/v1/merchant/not-a-route", "/api/v1/admin/not-a-route",
        "/api/v1/merchant/products/one/submit/extra", "/api/v1/products/one/extra", "/api/v1/admin/other/one/review",
        "/api/auth/not-a-route", "/api/auth/verify-email?token=old-token", "/api/auth/reset-password/old-token",
    ])("rejects %s without touching a business binding", async (path) => {
        const accessed: string[] = [];
        const env = Object.assign({} as AppEnv, { ORIGIN: "https://store.vrclearn.com" });
        for (const key of ["DB", "STATE", "ASSETS", "AUTH", "QUOTA", "PRIVATE_MEDIA", "PUBLIC_MEDIA"]) Object.defineProperty(env, key, { get() { accessed.push(key); throw new Error("Unexpected binding access"); } });
        const ctx = Object.assign({} as ExecutionContext, { waitUntil() { throw new Error("Unexpected background work"); } });
        for (const method of ["GET", "HEAD", "POST"]) {
            const response = await app.fetch(new Request(`https://store.vrclearn.com${path}`, { method }), env, ctx);
            expect(response.status).toBe(404);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
            if (method === "HEAD") expect(await response.text()).toBe("");
        }
        expect(accessed).toEqual([]);
    });
    it.each([
        ["/api/v1/config", "DELETE", "GET"], ["/api/v1/products", "HEAD", "GET"],
        ["/api/v1/merchant/workspace", "POST", "GET"], ["/api/v1/merchant/uploads", "GET", "POST"],
        ["/api/v1/favorites/item", "PATCH", "PUT, DELETE"], ["/api/v1/admin/queue", "POST", "GET"],
        ["/api/auth/sign-up/email", "GET", "POST"], ["/api/auth/get-session", "POST", "GET"],
        ["/api/auth/change-password", "HEAD", "POST"],
    ])("rejects unsupported %s %s before any business binding", async (path, method, allowed) => {
        const accessed: string[] = [];
        const env = Object.assign({} as AppEnv, { ORIGIN: "https://store.vrclearn.com" });
        for (const key of ["DB", "STATE", "ASSETS", "AUTH", "QUOTA", "PRIVATE_MEDIA", "PUBLIC_MEDIA"]) Object.defineProperty(env, key, { get() { accessed.push(key); throw new Error("Unexpected binding access"); } });
        const ctx = Object.assign({} as ExecutionContext, { waitUntil() { throw new Error("Unexpected background work"); } });
        const response = await app.fetch(new Request(`https://store.vrclearn.com${path}`, { method }), env, ctx);
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe(allowed);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(accessed).toEqual([]);
        if (method === "HEAD") expect(await response.text()).toBe("");
    });
    it.each(["/en/products/%E0%A4%A", "/ja/shops/%00", "/zh-CN/products/%2F", "/en/shops/%5C"])("rejects malformed detail segment %s without cache or business binding access", async (path) => {
        const accessed: string[] = [];
        const env = Object.assign({} as AppEnv, { ORIGIN: "https://store.vrclearn.com" });
        for (const key of ["DB", "STATE", "ASSETS", "AUTH", "QUOTA", "PRIVATE_MEDIA", "PUBLIC_MEDIA"]) Object.defineProperty(env, key, { get() { accessed.push(key); throw new Error("Unexpected binding access"); } });
        const ctx = Object.assign({} as ExecutionContext, { waitUntil() { throw new Error("Unexpected background work"); } });
        for (const method of ["GET", "HEAD"]) {
            const response = await app.fetch(new Request(`https://store.vrclearn.com${path}`, { method }), env, ctx);
            expect(response.status).toBe(404);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            if (method === "HEAD") expect(await response.text()).toBe("");
        }
        expect(accessed).toEqual([]);
    });
    it("keeps a single root redirect and no global SPA rewrite", () => {
        expect(readFileSync("public/_redirects", "utf8").trim()).toBe("/ /en 302");
    });
    it("does not allow raw HTML, JavaScript links or remote Markdown images", () => {
        const result = safeMarkdown('<script>alert(1)</script>\n\n[click](javascript:alert%281%29)\n\n![x](https://tracker.example/pixel)');
        expect(result).not.toContain("<script>");
        expect(result).not.toContain('href="javascript:');
        expect(result).not.toContain("<img");
    });
    it("escapes HTML attributes and script-data terminators", () => {
        expect(escapeHtml('\"<&')).toBe("&quot;&lt;&amp;");
        expect(safeJson({ text: "</script><script>alert(1)</script>" })).not.toContain("<");
    });
});
