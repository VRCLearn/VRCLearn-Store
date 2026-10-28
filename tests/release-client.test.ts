import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node scripts are tested directly.
import { createCloudflareClient } from "../scripts/release-cloudflare.mjs";

const token = "test-only-token-never-real";
const readPath = "/accounts/test-account/pages/projects/test-project";
const queryPath = "/accounts/test-account/d1/database/test-database/query";
const success = () => Response.json({ success: true, result: { matched: true } });
function client(transport: (url: string, options: RequestInit) => Promise<Response>, remaining = () => 10000) {
    const fetch = vi.fn(transport), sleep = vi.fn(async (_milliseconds: number) => {});
    return { api: createCloudflareClient(token, fetch, remaining, sleep), fetch, sleep };
}

describe("bounded Cloudflare read retries", () => {
    it("limits a GET connection failure to three attempts", async () => {
        const test = client(async () => { throw new TypeError("private transport diagnostic"); });
        await expect(test.api(readPath)).rejects.toThrow(/^CLOUDFLARE_READ_FAILED$/);
        expect(test.fetch).toHaveBeenCalledTimes(3);
        expect(test.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 750]);
    });
    it("shares a three-attempt budget between connection failure and 5xx", async () => {
        let count = 0;
        const test = client(async () => {
            count++;
            if (count === 1) throw new TypeError("reset");
            return count === 2 ? new Response("upstream failed", { status: 503 }) : success();
        });
        expect(await test.api(readPath)).toEqual({ matched: true });
        expect(test.fetch).toHaveBeenCalledTimes(3); expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it.each([
        { sql: "SELECT name FROM d1_migrations ORDER BY id", params: [] },
        { batch: [{ sql: "SELECT * FROM release_leases WHERE environment=?", params: ["test"] }, { sql: "SELECT 'DROP; UPDATE' AS label", params: [] }] },
    ])("retries an explicitly marked D1 SELECT POST at most twice: %j", async (body) => {
        const test = client(async () => new Response(null, { status: 502 }));
        await expect(test.api(queryPath, { method: "POST", body, write: false })).rejects.toThrow(/^CLOUDFLARE_HTTP_502$/);
        expect(test.fetch).toHaveBeenCalledTimes(3); expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it.each([
        { path: queryPath, method: "POST", body: { sql: "SELECT 1; INSERT INTO x VALUES(1);" }, write: false },
        { path: queryPath, method: "POST", body: { sql: "UPDATE release_leases SET lease_id=NULL" }, write: false },
        { path: readPath, method: "POST", body: { sql: "SELECT 1" }, write: false },
        { path: queryPath, method: "POST", body: { sql: "SELECT 1" }, write: true },
        { path: readPath, method: "PATCH", body: {}, write: true },
        { path: readPath, method: "GET", write: true },
    ])("never retries writes or unproven read operations: %j", async ({ path, ...options }) => {
        const test = client(async () => new Response(null, { status: 503 }));
        await expect(test.api(path, options)).rejects.toThrow(/^CLOUDFLARE_HTTP_503$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([429, 400, 401, 403, 404])("does not retry HTTP %s", async (status) => {
        const test = client(async () => new Response("not JSON", { status }));
        await expect(test.api(readPath)).rejects.toThrow(`CLOUDFLARE_HTTP_${status}`);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it.each([{ success: false, errors: [] }, { success: true, errors: [{ code: 1000 }] }, {}])("does not retry a 200 response with invalid success semantics: %j", async (payload) => {
        const test = client(async () => Response.json(payload));
        await expect(test.api(readPath)).rejects.toThrow(/^CLOUDFLARE_HTTP_200$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("does not retry syntactically invalid JSON", async () => {
        const test = client(async () => new Response("invalid JSON"));
        await expect(test.api(readPath)).rejects.toThrow(/^CLOUDFLARE_RESPONSE_INVALID$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("retries a read response-body transport failure within the same budget", async () => {
        let count = 0;
        const test = client(async () => {
            const response = success();
            if (++count < 3) response.text = async () => { throw new TypeError("connection reset during body"); };
            return response;
        });
        expect(await test.api(readPath)).toEqual({ matched: true });
        expect(test.fetch).toHaveBeenCalledTimes(3); expect(test.sleep).toHaveBeenCalledTimes(2);
    });
    it("never retries a write with an unconfirmed transport result", async () => {
        const test = client(async () => { throw new TypeError("private error"); });
        await expect(test.api(readPath, { method: "PATCH", body: {}, write: true })).rejects.toThrow(/^CLOUDFLARE_WRITE_UNCONFIRMED$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
    it("stops at the shared deadline before another attempt", async () => {
        let remaining = 1000;
        const test = client(async () => { remaining = 0; throw new TypeError("reset"); }, () => remaining);
        await expect(test.api(readPath)).rejects.toThrow(/^RELEASE_DEADLINE$/);
        expect(test.fetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled();
    });
});
