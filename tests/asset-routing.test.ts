import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
// @ts-expect-error build tooling intentionally uses native JavaScript modules
import { buildStaticPages, uiRoutes } from "../scripts/build-static.mjs";

describe("Workers static asset dispatch", () => {
    let directory: string;
    let runtime: Miniflare;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vrclearn-assets-"));
        await writeFile(join(directory, "index.html"), await readFile("index.html", "utf8"));
        await writeFile(join(directory, "_redirects"), await readFile("public/_redirects", "utf8"));
        await mkdir(join(directory, "assets"));
        await writeFile(join(directory, "assets/app.js"), "export const asset = true;");
        await buildStaticPages(directory, {});
        runtime = new Miniflare({
            cf: false, telemetry: { enabled: false },
            workers: [{ config: {
                name: "routing-fixture", compatibilityDate: "2026-10-23",
                manifest: { mainModule: "index.js", modules: { "index.js": {
                    type: "esm", contents: `export default { fetch(request) { return new Response(request.method === "HEAD" ? null : "user-worker", { status: 404, headers: { "X-User-Worker": "invoked", "Content-Type": "text/plain" } }); } };`,
                } } },
                assets: { directory, hasUserWorker: true, runWorkerFirst: uiRoutes.workerFirst, htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page" },
            } }],
        });
    }, 30000);
    afterAll(async () => {
        await runtime?.dispose();
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("serves every fixed three-language interface without invoking the user Worker", async () => {
        for (const locale of uiRoutes.locales) for (const page of uiRoutes.staticPages) {
            const path = `/${locale}${page ? `/${page}` : ""}`;
            for (const mode of ["navigate", "cors"]) {
                const response = await runtime.dispatchFetch(`https://store.example${path}`, { headers: { "Sec-Fetch-Mode": mode } });
                expect(response.status, path).toBe(200);
                expect(response.headers.get("X-User-Worker"), path).toBeNull();
                expect(await response.text()).toContain(`<html lang="${locale}">`);
            }
        }
    });
    it("serves immutable resources and the root redirect without invoking the user Worker", async () => {
        const asset = await runtime.dispatchFetch("https://store.example/assets/app.js");
        expect(asset.status).toBe(200);
        expect(asset.headers.get("X-User-Worker")).toBeNull();
        expect(asset.headers.get("Cache-Control")).toContain("immutable");
        const root = await runtime.dispatchFetch("https://store.example/", { redirect: "manual" });
        expect(root.status).toBe(302);
        expect(root.headers.get("Location")).toBe("/en");
        expect(root.headers.get("X-User-Worker")).toBeNull();
    });
    it.each(["/api/v1/products", "/api/auth/sign-in/email", "/en/products/example", "/zh-CN/shops/example", "/ja/products/example", "/sitemap.xml", "/sitemaps/en.xml"])("always dispatches %s to the user Worker for navigation and fetch", async (path) => {
        for (const mode of ["navigate", "cors"]) for (const method of ["GET", "HEAD"]) {
            const response = await runtime.dispatchFetch(`https://store.example${path}`, { method, headers: { "Sec-Fetch-Mode": mode } });
            expect(response.headers.get("X-User-Worker"), `${method} ${mode} ${path}`).toBe("invoked");
            if (method === "HEAD") expect(await response.text()).toBe("");
        }
    });
    it.each(["/random-path", "/assets/missing.js", "/en/reset-password"])("returns a real 404 instead of an SPA shell for %s", async (path) => {
        for (const mode of ["navigate", "cors"]) {
            const response = await runtime.dispatchFetch(`https://store.example${path}`, { headers: { "Sec-Fetch-Mode": mode } });
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain("<h1>Find your next expression.</h1>");
        }
    });
});
