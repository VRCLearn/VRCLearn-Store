import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../server/env";
import { imageInfo } from "../server/media";
import { HttpError, isPublicHttps, mode, readBytes, regionOf, secureOrigin, turnstile } from "../server/security";
import { ftsQuery, productSchema, searchTokens } from "../server/validation";

const env = { ORIGIN: "https://store.vrclearn.com", ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "test-only-secret" } as AppEnv;

describe("untrusted external URLs", () => {
    it.each(["http://example.com", "https://name:secret@example.com", "https://localhost", "https://localhost.", "https://foo.local.", "https://127.0.0.1", "https://10.1.2.3", "https://172.16.1.2", "https://192.168.2.1", "https://169.254.169.254", "https://[::1]", "https://foo.internal", "javascript:alert(1)", "https://2130706433", "https://0x7f000001", "https://example.com:8443"])("rejects %s", (value) => expect(isPublicHttps(value)).toBe(false));
    it.each(["https://example.com/a?x=y#z", "https://booth.pm/ja/items/123", "https://shop.example.org"])("accepts %s", (value) => expect(isPublicHttps(value)).toBe(true));
});

describe("server-owned geographic boundary", () => {
    function request(country?: string): Request {
        const request = new Request("https://store.vrclearn.com/api/v1/products?region=cn");
        if (country) Object.defineProperty(request, "cf", { value: { country } });
        return request;
    }
    it("only maps mainland CN into cn", () => {
        expect(regionOf(request("CN"))).toBe("cn");
        for (const country of ["HK", "MO", "TW", "JP", "US"]) expect(regionOf(request(country))).toBe("intl");
    });
    it("fails closed for unknown edge data", () => {
        expect(() => regionOf(request())).toThrow(HttpError);
        expect(() => regionOf(request("XX"))).toThrow(HttpError);
        expect(() => regionOf(request("T1"))).toThrow(HttpError);
    });
    it("rejects cross-site writes even with a valid Origin", () => {
        expect(() => secureOrigin(new Request(env.ORIGIN, { headers: { Origin: env.ORIGIN, "Sec-Fetch-Site": "cross-site" } }), env)).toThrow(HttpError);
        expect(() => secureOrigin(new Request(env.ORIGIN, { headers: { Origin: "https://evil.example" } }), env)).toThrow(HttpError);
        expect(() => secureOrigin(new Request(env.ORIGIN, { headers: { Origin: env.ORIGIN, "Sec-Fetch-Site": "same-origin" } }), env)).not.toThrow();
    });
});

describe("bounded bodies and image validation", () => {
    it("enforces the streamed length independently of Content-Length", async () => {
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)); controller.close(); } });
        const request = new Request("https://example.com", { method: "POST", body: stream, duplex: "half" } as RequestInit);
        await expect(readBytes(request, 10)).rejects.toMatchObject({ status: 413 });
    });
    it("accepts bounded data and rejects declared overflow", async () => {
        expect(await readBytes(new Request("https://example.com", { method: "POST", body: "hello" }), 10)).toHaveLength(5);
        await expect(readBytes(new Request("https://example.com", { method: "POST", body: "hello", headers: { "Content-Length": "100" } }), 10)).rejects.toMatchObject({ status: 413 });
    });
    it("checks image signatures and dimensions rather than extension or MIME", () => {
        expect(() => imageInfo(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toThrow(HttpError);
        const png = new Uint8Array(33);
        png.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(png.buffer);
        view.setUint32(8, 13);
        view.setUint32(12, 0x49484452);
        view.setUint32(16, 1280);
        view.setUint32(20, 720);
        expect(imageInfo(png)).toEqual({ contentType: "image/png", width: 1280, height: 720 });
        view.setUint32(16, 20000);
        expect(() => imageInfo(png)).toThrow(HttpError);
        view.setUint32(16, 8192);
        view.setUint32(20, 8192);
        expect(() => imageInfo(png)).toThrow(HttpError);
    });
});

describe("search input and content contract", () => {
    it("indexes Chinese and Japanese bigrams and normalized English words", () => {
        expect(searchTokens("模型服饰 アバター ＶＲＣhat")).toEqual(["模型", "型服", "服饰", "アバ", "バタ", "ター", "vrchat"]);
    });
    it("turns FTS operators and punctuation into quoted literal tokens", () => {
        expect(ftsQuery('foo" OR NEAR(bar*)')).toBe('"foo" AND "or" AND "near" AND "bar"');
        expect(ftsQuery("\"*()")).toBe("");
        expect(ftsQuery("word ".repeat(100)).length).toBeLessThan(300);
    });
    it("rejects R18 and arbitrary content fields", () => {
        const product = { title: "Test", language: "en", summary: "Summary", description: "Description", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://example.com/product", mediaIds: [], r18: false };
        expect(productSchema.safeParse(product).success).toBe(true);
        expect(productSchema.safeParse({ ...product, r18: true }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, ownerId: "someone-else" }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, currency: null }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, price: -1 }).success).toBe(false);
    });
});

describe("verification and stale metering", () => {
    it("binds Turnstile proof to hostname and action", async () => {
        const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, hostname: "store.vrclearn.com", action: "submit" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
        mock.mockResolvedValue(Response.json({ success: true, hostname: "evil.example", action: "upload" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
        mock.mockResolvedValue(Response.json({ success: true, hostname: "store.vrclearn.com", action: "upload" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).resolves.toBeUndefined();
        mock.mockRestore();
    });
    it("blocks expensive production operations when costs are unknown or stale", async () => {
        const production = { ...env, STATE: { get: vi.fn().mockResolvedValue(null), getWithMetadata: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as KVNamespace };
        await expect(mode(production, true)).rejects.toMatchObject({ code: "SERVICE_PAUSED" });
        await expect(mode(production)).resolves.toBeUndefined();
        production.STATE.get = vi.fn().mockResolvedValue({ mode: "normal", updatedAt: new Date(Date.now() - 1900000).toISOString() });
        await expect(mode(production, true)).rejects.toMatchObject({ code: "SERVICE_PAUSED" });
        production.STATE.get = vi.fn().mockResolvedValue({ mode: "normal", updatedAt: new Date().toISOString() });
        await expect(mode(production, true)).resolves.toBeUndefined();
    });
});
