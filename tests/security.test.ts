import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../server/env";
import { imageInfo } from "../server/media";
import { failure, HttpError, isPublicHttps, readBytes, regionOf, reserve, secureOrigin, turnstile } from "../server/security";
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
    it("accepts explicit adult classification and rejects malformed or arbitrary content fields", () => {
        const product = { title: "Test", language: "en", summary: "Summary", description: "Description", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://example.com/product", mediaIds: [], r18: false };
        expect(productSchema.safeParse(product).success).toBe(true);
        expect(productSchema.safeParse({ ...product, platforms: ["ios"] }).success).toBe(true);
        expect(productSchema.safeParse({ ...product, platforms: ["pc", "android", "ios"] }).success).toBe(true);
        expect(productSchema.safeParse({ ...product, platforms: ["unsupported"] }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, r18: true }).success).toBe(true);
        expect(productSchema.safeParse({ ...product, r18: "true" }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, ownerId: "someone-else" }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, currency: null }).success).toBe(false);
        expect(productSchema.safeParse({ ...product, price: -1 }).success).toBe(false);
    });
});

describe("human verification", () => {
    it("binds Turnstile proof to hostname and action", async () => {
        const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, hostname: "store.vrclearn.com", action: "submit" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
        mock.mockResolvedValue(Response.json({ success: true, hostname: "evil.example", action: "upload" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
        mock.mockResolvedValue(Response.json({ success: true, hostname: "store.vrclearn.com", action: "upload" }));
        await expect(turnstile(new Request(env.ORIGIN), env, "proof", "upload")).resolves.toBeUndefined();
        mock.mockRestore();
    });

});

describe("quota denial responses", () => {
    const limits = [{ key: "test:day", limit: 1, windowSeconds: 86400 }];
    function quotaEnvironment(response: Response) {
        const fetch = vi.fn(async () => response);
        return { env: { ...env, QUOTA: Object.assign({} as AppEnv["QUOTA"], { getByName: () => ({ fetch }) }) }, fetch };
    }
    it.each([
        { duplicate: false, status: 429, code: "QUOTA_EXCEEDED" },
        { duplicate: true, status: 409, code: "DUPLICATE_OPERATION" },
    ])("preserves the denial and Retry-After for duplicate=$duplicate", async ({ duplicate, status, code }) => {
        const f = quotaEnvironment(Response.json({ allowed: false, duplicate, retryAfter: 37 }, { status: 429 }));
        const result = await reserve(f.env, limits).catch((error: unknown) => failure(error));
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) throw new Error("Expected quota denial");
        expect(result.status).toBe(status);
        expect(result.headers.get("Retry-After")).toBe("37");
        expect(await result.json()).toMatchObject({ error: { code } });
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it("accepts one successful reservation", async () => {
        const f = quotaEnvironment(Response.json({ allowed: true }));
        await expect(reserve(f.env, limits)).resolves.toBeUndefined();
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it.each([
        new Response("unavailable", { status: 503 }),
        new Response("invalid JSON", { status: 429 }),
        Response.json({ allowed: false }, { status: 200 }),
        Response.json({ allowed: true }, { status: 429 }),
        Response.json({ allowed: true, duplicate: true }),
        Response.json({ allowed: false, retryAfter: -1 }, { status: 429 }),
        Response.json({ allowed: "false" }, { status: 429 }),
    ])("fails closed for a failed or malformed quota response", async (response) => {
        const f = quotaEnvironment(response);
        await expect(reserve(f.env, limits)).rejects.toMatchObject({ status: 503, code: "QUOTA_UNAVAILABLE" });
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it("maps a failed quota binding call to service unavailable", async () => {
        const production = { ...env, QUOTA: Object.assign({} as AppEnv["QUOTA"], { getByName: () => { throw new Error("Binding unavailable"); } }) };
        await expect(reserve(production, limits)).rejects.toMatchObject({ status: 503, code: "QUOTA_UNAVAILABLE" });
    });
});
