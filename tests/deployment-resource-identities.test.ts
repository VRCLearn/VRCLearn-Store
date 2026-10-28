import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { validateEnvironments } from "../scripts/environment.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { createReleaseIO } from "../scripts/release-cloudflare.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { runRelease } from "../scripts/release-core.mjs";

const actual = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
const sha = "a".repeat(40);
const context = (manifest: typeof actual, environment = "test") => ({
    environment, accountId: manifest.accountId, branch: manifest[environment].branch,
    pagesProject: manifest[environment].pages.name, pagesProjectId: manifest[environment].pages.id,
    releaseDatabaseId: manifest.control.releaseDatabase.id, d1DatabaseId: manifest[environment].database.id,
    stateId: manifest[environment].state.id, profile: manifest[environment], manifest,
});

function remoteInventory(namespaces = [actual.production.state, actual.test.state].map((state) => ({ id: state.id, title: state.name }))) {
    const databases = [actual.production.database, actual.test.database, actual.control.releaseDatabase].map((database) => ({ uuid: database.id, name: database.name }));
    const api = vi.fn(async (path: string, options: { method?: string } = {}) => {
        if ((options.method ?? "GET") !== "GET") throw new Error("Unexpected write during resource verification");
        const id = /\/d1\/database\/([^/?]+)$/.exec(path)?.[1];
        if (id) return databases.find((database) => database.uuid === id);
        const query = new URL(`https://api.cloudflare.com${path}`);
        if (!query.pathname.endsWith("/storage/kv/namespaces")) throw new Error("Unexpected resource lookup");
        expect(query.searchParams.get("per_page")).toBe("100");
        expect(query.searchParams.get("order")).toBe("id");
        expect(query.searchParams.get("direction")).toBe("asc");
        const page = Number(query.searchParams.get("page"));
        expect(page).toBeGreaterThanOrEqual(1);
        expect(page).toBeLessThanOrEqual(5);
        return namespaces.slice((page - 1) * 100, page * 100);
    });
    return { api, databases };
}

describe("remote deployment resource identities before any write", () => {
    it.each(["production", "test"])("checks actual %s D1 and KV names and the release control database", async (environment) => {
        const target = context(structuredClone(actual), environment);
        const { api } = remoteInventory();
        const io = createReleaseIO(target, {}, { api });
        await expect(io.verifyResourceIdentities()).resolves.toBeUndefined();
        expect(api.mock.calls.map(([path]) => path)).toEqual([
            `/accounts/${target.accountId}/d1/database/${target.releaseDatabaseId}`,
            `/accounts/${target.accountId}/d1/database/${target.d1DatabaseId}`,
            `/accounts/${target.accountId}/storage/kv/namespaces?page=1&per_page=100&order=id&direction=asc`,
        ]);
        expect(actual.production.state.name).toBe("VRCLearn Store State");
    });

    it.each(["business D1", "business KV", "control D1"])("rejects a unique but swapped %s ID before acquiring a lease or changing any data", async (kind) => {
        const manifest = structuredClone(actual);
        if (kind === "business D1") [manifest.test.database.id, manifest.production.database.id] = [manifest.production.database.id, manifest.test.database.id];
        else if (kind === "business KV") [manifest.test.state.id, manifest.production.state.id] = [manifest.production.state.id, manifest.test.state.id];
        else [manifest.control.releaseDatabase.id, manifest.test.database.id] = [manifest.test.database.id, manifest.control.releaseDatabase.id];
        // Uniqueness alone cannot establish which real resource an ID denotes.
        expect(validateEnvironments(manifest)).toEqual([]);
        const target = context(manifest);
        const { api } = remoteInventory();
        const writes = {
            acquireLease: vi.fn(async () => true), mark: vi.fn(), failLease: vi.fn(),
            applyMigration: vi.fn(), deploySupport: vi.fn(), setPagesRelease: vi.fn(), startPages: vi.fn(),
        };
        const log = vi.fn();
        const io = createReleaseIO(target, {}, { api, ...writes, headSha: vi.fn(async () => sha), log });
        const expected = kind === "business KV" ? "KV_RESOURCE_IDENTITY_MISMATCH" : "D1_RESOURCE_IDENTITY_MISMATCH";
        await expect(runRelease(target, { branch: "test", sha, platformSha: sha, projectName: target.pagesProject, dirty: false }, io)).rejects.toThrow(expected);
        for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
        expect(api.mock.calls.every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "release_failed", stage: "resources", code: expected, uncertain: false }));
        if (kind === "control D1") expect(api).toHaveBeenCalledOnce();
    });

    it("does not accept a database name when the returned UUID differs", async () => {
        const target = context(structuredClone(actual));
        const { api, databases } = remoteInventory();
        const original = api.getMockImplementation()!;
        api.mockImplementation(async (path, options) => path.endsWith(target.d1DatabaseId) ? { ...databases.find((database) => database.uuid === target.d1DatabaseId)!, uuid: actual.production.database.id } : original(path, options));
        await expect(createReleaseIO(target, {}, { api }).verifyResourceIdentities()).rejects.toThrow("D1_RESOURCE_IDENTITY_MISMATCH");
    });

    it("finds the expected KV namespace on a later bounded page", async () => {
        const filler = Array.from({ length: 100 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, "0"), title: `Other namespace ${index}` }));
        const { api } = remoteInventory([...filler, { id: actual.test.state.id, title: actual.test.state.name }]);
        await expect(createReleaseIO(context(structuredClone(actual)), {}, { api }).verifyResourceIdentities()).resolves.toBeUndefined();
        expect(api.mock.calls.filter(([path]) => path.includes("/storage/kv/namespaces"))).toHaveLength(2);
    });

    it("stops after five namespace pages if the expected ID cannot be established", async () => {
        const filler = Array.from({ length: 600 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, "0"), title: `Other namespace ${index}` }));
        const { api } = remoteInventory(filler);
        await expect(createReleaseIO(context(structuredClone(actual)), {}, { api }).verifyResourceIdentities()).rejects.toThrow("KV_NAMESPACE_LOOKUP_LIMIT");
        expect(api.mock.calls.filter(([path]) => path.includes("/storage/kv/namespaces"))).toHaveLength(5);
    });

    it("rejects missing namespaces and malformed or repeating page results", async () => {
        const target = context(structuredClone(actual));
        const missing = remoteInventory([]);
        await expect(createReleaseIO(target, {}, { api: missing.api }).verifyResourceIdentities()).rejects.toThrow("KV_RESOURCE_IDENTITY_MISMATCH");
        const malformed = remoteInventory();
        const original = malformed.api.getMockImplementation()!;
        malformed.api.mockImplementation(async (path, options) => path.includes("/storage/kv/namespaces") ? [{ id: actual.test.state.id, title: 42 }] : original(path, options));
        await expect(createReleaseIO(target, {}, { api: malformed.api }).verifyResourceIdentities()).rejects.toThrow("KV_NAMESPACE_LIST_INVALID");
        const duplicate = remoteInventory([{ id: actual.production.state.id, title: actual.production.state.name }, { id: actual.production.state.id, title: actual.production.state.name }]);
        await expect(createReleaseIO(target, {}, { api: duplicate.api }).verifyResourceIdentities()).rejects.toThrow("KV_NAMESPACE_LIST_INVALID");
    });
});
