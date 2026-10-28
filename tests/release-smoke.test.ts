import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node deployment adapter.
import { createReleaseIO } from "../scripts/release-cloudflare.mjs";
import { deploymentContext, releaseSha as sha } from "./deployment-fixture";

const target = deploymentContext();
const redirect = () => new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } });
const config = () => Response.json({ releaseSha: sha, deploymentEnvironment: "test" });
function fixture(transport: (url: string, options: RequestInit) => Promise<Response>) {
    const fetch = vi.fn(transport), sleep = vi.fn(async (_milliseconds: number) => {});
    const io = createReleaseIO(target, { CF_ACCESS_CLIENT_ID: "test-client", CF_ACCESS_CLIENT_SECRET: "never-real" }, { api: vi.fn(), fetch, sleep });
    return { io, fetch, sleep, run: () => io.smoke({ sha }) };
}
describe("bounded Worker smoke requests", () => {
    it("checks site, API, media Access and then the authenticated release identity", async () => {
        const test = fixture(async (_url, options) => options.headers ? config() : redirect()); await test.run();
        expect(test.fetch).toHaveBeenCalledTimes(4);
        expect(test.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/en", "/api/v1/config", "/intl/release-probe", "/api/v1/config"]);
    });
    it("retries connection failures and 5xx at most twice with bounded backoff", async () => {
        const test = fixture(async () => { throw new Error("private transport detail"); });
        await expect(test.run()).rejects.toThrow(/^SMOKE_SITE_TRANSPORT_FAILED$/);
        expect(test.fetch).toHaveBeenCalledTimes(3); expect(test.sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 750]);
        const unavailable = fixture(async () => new Response(null, { status: 503 }));
        await expect(unavailable.run()).rejects.toThrow(/^SMOKE_SITE_HTTP_FAILED$/); expect(unavailable.fetch).toHaveBeenCalledTimes(3);
    });
    it.each([429, 400, 401, 403, 404])("does not retry anonymous status %s", async (status) => {
        const test = fixture(async () => new Response(null, { status })); await expect(test.run()).rejects.toThrow("SMOKE_SITE_HTTP_FAILED"); expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("rejects incorrect Access redirects", async () => {
        const test = fixture(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/login" } }));
        await expect(test.run()).rejects.toThrow("SMOKE_SITE_ACCESS_FAILED"); expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([429, 400, 404])("does not retry authenticated status %s", async (status) => {
        const test = fixture(async (_url, options) => options.headers ? new Response(null, { status }) : redirect());
        await expect(test.run()).rejects.toThrow("SMOKE_CONFIG_HTTP_FAILED"); expect(test.fetch).toHaveBeenCalledTimes(4); expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([302, 401, 403])("distinguishes authenticated Access rejection %s", async (status) => {
        const test = fixture(async (_url, options) => options.headers ? new Response(null, { status }) : redirect()); await expect(test.run()).rejects.toThrow("SMOKE_CONFIG_ACCESS_FAILED");
    });
    it("does not retry semantic JSON or SHA failures", async () => {
        const invalid = fixture(async (_url, options) => options.headers ? new Response("invalid", { headers: { "content-type": "application/json" } }) : redirect());
        await expect(invalid.run()).rejects.toThrow("SMOKE_CONFIG_RESPONSE_INVALID"); expect(invalid.fetch).toHaveBeenCalledTimes(4);
        const wrong = fixture(async (_url, options) => options.headers ? Response.json({ releaseSha: "b".repeat(40), deploymentEnvironment: "test" }) : redirect());
        await expect(wrong.run()).rejects.toThrow("SMOKE_CONFIG_RELEASE_MISMATCH"); expect(wrong.sleep).not.toHaveBeenCalled();
    });
    it("keeps the overall deadline in force before another request", async () => {
        const test = fixture(async () => redirect()); test.io.setDeadline(Date.now() - 1); await expect(test.run()).rejects.toThrow("RELEASE_DEADLINE"); expect(test.fetch).not.toHaveBeenCalled();
    });
});
