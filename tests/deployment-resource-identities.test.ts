import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node deployment adapter.
import { createReleaseIO, verifyWorkerBindings } from "../scripts/release-cloudflare.mjs";
import { deploymentContext, workerSettings } from "./deployment-fixture";

function inventory() {
    const profile = deploymentContext();
    const databases = [{ uuid: profile.releaseDatabaseId, name: profile.profile.releaseDatabase.name }, { uuid: profile.d1DatabaseId, name: profile.profile.database.name }];
    const namespaces = [{ id: profile.stateId, title: profile.profile.state.name }];
    const api = vi.fn(async (path: string): Promise<any> => {
        if (path.includes("/scripts-search?")) {
            const id = new URL("https://example.com" + path).searchParams.get("id");
            return [{ id, script_name: id === profile.appWorkerId ? profile.appWorker : profile.supportWorker }];
        }
        return path.includes("/storage/kv/") ? namespaces : databases.find((database) => path.endsWith(database.uuid));
    });
    return { profile, api, databases, namespaces };
}
describe("cloud resource readback precedes release writes", () => {
    it("checks exact D1 names/IDs and the business namespace title", async () => {
        const { profile, api } = inventory();
        await expect(createReleaseIO(profile, {}, { api }).verifyResourceIdentities()).resolves.toBeUndefined();
        expect(api).toHaveBeenCalledTimes(5);
    });
    it.each(["control", "business", "namespace"])("rejects an incorrect %s resource", async (kind) => {
        const { profile, api, databases, namespaces } = inventory();
        if (kind === "namespace") namespaces[0].title = "other"; else databases[kind === "control" ? 0 : 1].name = "other";
        await expect(createReleaseIO(profile, {}, { api }).verifyResourceIdentities()).rejects.toThrow("RESOURCE_IDENTITY_MISMATCH");
    });
    it("rejects a release control ID that is the business database before querying it", async () => {
        const { profile, api } = inventory(); profile.releaseDatabaseId = profile.d1DatabaseId;
        await expect(createReleaseIO(profile, {}, { api }).verifyResourceIdentities()).rejects.toThrow("D1_RESOURCE_IDENTITY_MISMATCH"); expect(api).not.toHaveBeenCalled();
    });
    it("bounds namespace discovery at five pages", async () => {
        const { profile, api } = inventory(), original = api.getMockImplementation()!;
        api.mockImplementation(async (path: string) => {
            if (!path.includes("/storage/kv/")) return original(path);
            const page = Number(new URL("https://example.com" + path).searchParams.get("page"));
            return Array.from({ length: 100 }, (_, index) => ({ id: (page * 1000 + index).toString(16).padStart(32, "0"), title: "other" }));
        });
        await expect(createReleaseIO(profile, {}, { api }).verifyResourceIdentities()).rejects.toThrow("KV_NAMESPACE_LOOKUP_LIMIT");
        expect(api.mock.calls.filter(([path]) => path.includes("/storage/kv/"))).toHaveLength(5);
    });
    it("requires exact app/support runtime capabilities, secrets, origins and CPU limits", () => {
        const profile = deploymentContext();
        for (const kind of ["app", "support"] as const) {
            expect(() => verifyWorkerBindings(profile, workerSettings(profile, kind), kind)).not.toThrow();
            const extra = workerSettings(profile, kind); extra.bindings.push({ name: "EMAIL", type: "send_email" });
            expect(() => verifyWorkerBindings(profile, extra, kind)).toThrow("EXTRA_BINDING");
            const shared = workerSettings(profile, kind); const database = shared.bindings.find((binding) => binding.name === "DB");
            if (!database || !("id" in database)) throw new Error("Missing fixture D1 binding");
            database.id = "other";
            expect(() => verifyWorkerBindings(profile, shared, kind)).toThrow("BINDING_MISMATCH");
            const cpu = workerSettings(profile, kind); cpu.limits.cpu_ms = 999;
            expect(() => verifyWorkerBindings(profile, cpu, kind)).toThrow("SECURITY_MISMATCH");
        }
    });
});
