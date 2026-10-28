import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node scripts are tested directly.
import { createCloudflareClient, createReleaseIO } from "../scripts/release-cloudflare.mjs";
// @ts-ignore Native Node scripts are tested directly.
import { ReleaseFailure } from "../scripts/release-core.mjs";

const sha = "a".repeat(40);
const target = { environment: "test", branch: "test", accountId: "test-account", pagesProject: "test-vrclearn-store", origin: "https://test-store.example.com", mediaOrigin: "https://test-media.example.com" };
const redirect = () => new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } });
const config = () => Response.json({ releaseSha: sha, deploymentEnvironment: "test" });
function fixture(transport: (url: string, options: RequestInit) => Promise<Response>) {
    const fetch = vi.fn(transport), sleep = vi.fn(async (_milliseconds: number) => {});
    const api = vi.fn(async () => ({ url: "https://12345678.test-vrclearn-store.pages.dev" }));
    const io = createReleaseIO(target, { CF_ACCESS_CLIENT_ID: "test-client", CF_ACCESS_CLIENT_SECRET: "never-real" }, { api, fetch, sleep });
    return { io, api, fetch, sleep, run: () => io.smoke({ sha, pagesDeploymentId: "deployment" }) };
}

describe("bounded smoke GET retries", () => {
    it("retries transport errors at most twice and discards private diagnostics", async () => {
        const test = fixture(async () => { throw new Error("private connection details with secret material"); });
        await expect(test.run()).rejects.toThrow(/^SMOKE_SITE_TRANSPORT_FAILED$/);
        expect(test.fetch).toHaveBeenCalledTimes(3);
        expect(test.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 750]);
        for (const [, options] of test.fetch.mock.calls) expect(options).toMatchObject({ method: "GET", redirect: "manual" });
    });
    it("shares the three-attempt limit between transport errors and 5xx", async () => {
        let siteAttempts = 0;
        const test = fixture(async (url, options) => {
            if (url.endsWith("/en") && url.startsWith(target.origin)) {
                siteAttempts++;
                if (siteAttempts === 1) throw new TypeError("connection reset");
                if (siteAttempts === 2) return new Response(null, { status: 503 });
            }
            return options.headers ? config() : redirect();
        });
        await test.run();
        expect(siteAttempts).toBe(3); expect(test.fetch).toHaveBeenCalledTimes(8); expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it("stops after three 5xx responses", async () => {
        const test = fixture(async () => new Response(null, { status: 502 }));
        await expect(test.run()).rejects.toThrow(/^SMOKE_SITE_HTTP_FAILED$/);
        expect(test.fetch).toHaveBeenCalledTimes(3); expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it.each([429, 400, 401, 403, 404])("does not retry anonymous HTTP %s", async (status) => {
        const test = fixture(async () => new Response(null, { status }));
        await expect(test.run()).rejects.toThrow(/^SMOKE_SITE_HTTP_FAILED$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("does not retry or expose a wrong Access redirect", async () => {
        const test = fixture(async () => new Response(null, { status: 302, headers: { location: "https://unexpected.example/login?private=never-log" } }));
        await expect(test.run()).rejects.toThrow(/^SMOKE_SITE_ACCESS_FAILED$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("uses fixed target labels for default-host transport failure", async () => {
        const test = fixture(async (url) => {
            if (url.startsWith("https://test-vrclearn-store.pages.dev")) throw new TypeError("private transport response");
            return redirect();
        });
        await expect(test.run()).rejects.toThrow(/^SMOKE_DEFAULT_TRANSPORT_FAILED$/);
        expect(test.fetch.mock.calls.filter(([url]) => url.startsWith("https://test-vrclearn-store.pages.dev"))).toHaveLength(3);
    });
    it("retries an authenticated response-body connection failure", async () => {
        let authenticatedAttempts = 0;
        const test = fixture(async (_url, options) => {
            if (!options.headers) return redirect();
            authenticatedAttempts++;
            const response = config();
            if (authenticatedAttempts === 1) response.json = async () => { throw new TypeError("connection reset while reading body"); };
            return response;
        });
        await test.run();
        expect(authenticatedAttempts).toBe(2); expect(test.sleep).toHaveBeenCalledExactlyOnceWith(250);
    });
    it("caps authenticated 5xx retries at three attempts", async () => {
        const test = fixture(async (_url, options) => options.headers ? new Response(null, { status: 503 }) : redirect());
        await expect(test.run()).rejects.toThrow(/^SMOKE_CONFIG_HTTP_FAILED$/);
        expect(test.fetch.mock.calls.filter(([, options]) => options.headers)).toHaveLength(3);
        expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it("caps authenticated connection resets at three attempts", async () => {
        const test = fixture(async (_url, options) => {
            if (options.headers) throw new TypeError("private connection reset detail");
            return redirect();
        });
        await expect(test.run()).rejects.toThrow(/^SMOKE_CONFIG_TRANSPORT_FAILED$/);
        expect(test.fetch.mock.calls.filter(([, options]) => options.headers)).toHaveLength(3);
        expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it("does not add another retry layer around the metadata client", async () => {
        const test = fixture(async () => redirect());
        test.api.mockRejectedValue(new ReleaseFailure("CLOUDFLARE_READ_FAILED", "api"));
        await expect(test.run()).rejects.toThrow(/^SMOKE_DEPLOYMENT_TRANSPORT_FAILED$/);
        expect(test.api).toHaveBeenCalledOnce(); expect(test.fetch).not.toHaveBeenCalled();
        expect(test.sleep).not.toHaveBeenCalled();
    });
    it("performs at most three metadata HTTP attempts across the unified client and smoke", async () => {
        const transport = vi.fn(async () => { throw new TypeError("private metadata connection reset"); });
        const sleep = vi.fn(async (_milliseconds: number) => {});
        const api = createCloudflareClient("test-only-token-never-real", transport, () => 10000, sleep);
        const io = createReleaseIO(target, {}, { api, sleep });
        await expect(io.smoke({ sha, pagesDeploymentId: "deployment" })).rejects.toThrow(/^SMOKE_DEPLOYMENT_TRANSPORT_FAILED$/);
        expect(transport).toHaveBeenCalledTimes(3); expect(sleep).toHaveBeenCalledTimes(2);
    });
    it("does not retry a metadata GET returning 429", async () => {
        const test = fixture(async () => redirect());
        test.api.mockRejectedValue(new ReleaseFailure("CLOUDFLARE_HTTP_429", "api"));
        await expect(test.run()).rejects.toThrow(/^SMOKE_DEPLOYMENT_HTTP_FAILED$/);
        expect(test.api).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([429, 400, 404])("does not retry authenticated HTTP %s", async (status) => {
        const test = fixture(async (_url, options) => options.headers ? new Response(null, { status }) : redirect());
        await expect(test.run()).rejects.toThrow(/^SMOKE_CONFIG_HTTP_FAILED$/);
        expect(test.fetch.mock.calls.filter(([, options]) => options.headers)).toHaveLength(1);
        expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([302, 401, 403])("distinguishes authenticated Access rejection HTTP %s", async (status) => {
        const test = fixture(async (_url, options) => options.headers ? new Response(null, { status }) : redirect());
        await expect(test.run()).rejects.toThrow(/^SMOKE_CONFIG_ACCESS_FAILED$/);
        expect(test.fetch.mock.calls.filter(([, options]) => options.headers)).toHaveLength(1);
        expect(test.sleep).not.toHaveBeenCalled();
    });
    it("does not retry invalid JSON or a wrong release identity", async () => {
        const invalid = fixture(async (_url, options) => options.headers ? new Response("invalid", { headers: { "content-type": "application/json" } }) : redirect());
        await expect(invalid.run()).rejects.toThrow(/^SMOKE_CONFIG_RESPONSE_INVALID$/);
        expect(invalid.fetch).toHaveBeenCalledTimes(6); expect(invalid.sleep).not.toHaveBeenCalled();
        const wrong = fixture(async (_url, options) => options.headers ? Response.json({ releaseSha: "b".repeat(40), deploymentEnvironment: "test" }) : redirect());
        await expect(wrong.run()).rejects.toThrow(/^SMOKE_CONFIG_RELEASE_MISMATCH$/);
        expect(wrong.fetch).toHaveBeenCalledTimes(6); expect(wrong.sleep).not.toHaveBeenCalled();
    });
    it("keeps the overall release deadline in force before another HTTP attempt", async () => {
        const test = fixture(async () => redirect());
        test.io.setDeadline(Date.now() - 1);
        await expect(test.run()).rejects.toThrow(/^RELEASE_DEADLINE$/);
        expect(test.fetch).not.toHaveBeenCalled(); expect(test.sleep).not.toHaveBeenCalled();
    });
});
