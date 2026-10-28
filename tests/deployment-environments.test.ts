import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore Native Node configuration scripts are tested directly.
import { buildEnvironmentConfigs, buildEdgePolicies, loadDeployment, validateEnvironments, workerFirstRoutes } from "../scripts/environment.mjs";
// @ts-ignore Native Node configuration scripts are tested directly.
import { validateBuiltApplication, validateBuiltSupport, validateDeploymentArtifacts, validateEdgeArtifacts, verifyRemoteHead } from "../scripts/preflight.mjs";
import { deploymentFixture, releaseSha } from "./deployment-fixture";

describe("independent Workers deployment profiles", () => {
    it("keeps the production architecture without opening production or retaining retired resource IDs", () => {
        const manifest = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
        expect(manifest.production.enabled).toBe(false);
        expect(manifest.production.provisioned).toBe(false);
        expect(validateEnvironments(manifest)).toEqual([]);
        expect(manifest.control).toBeUndefined();
        expect(manifest.production.app.id).toBeNull();
    });
    it("rejects production before loading any deployment API client", async () => {
        await expect(loadDeployment("production")).rejects.toThrow("DEPLOYMENT_DISABLED");
        expect(() => buildEnvironmentConfigs(deploymentFixture(), "production", { releaseSha })).toThrow("DEPLOYMENT_DISABLED");
    });
    it("generates app and support bindings with distinct CPU budgets and no email or account-control capabilities", () => {
        const manifest = deploymentFixture(), configs = buildEnvironmentConfigs(manifest, "test", { releaseSha });
        expect(configs.app.name).toBe("test-vrclearn-store");
        expect(configs.app.routes).toEqual([{ pattern: "test-store.vrclearn.com", custom_domain: true }]);
        expect(buildEnvironmentConfigs(manifest, "test", { releaseSha, bootstrap: true }).app.routes).toBeUndefined();
        expect(configs.app.assets.run_worker_first).toEqual(workerFirstRoutes);
        expect(configs.app.assets.not_found_handling).toBe("404-page");
        expect(configs.app.limits.cpu_ms).toBe(50); expect(configs.support.limits.cpu_ms).toBe(500);
        expect(configs.app.services).toEqual([{ binding: "AUTH", service: manifest.test.support.name }]);
        for (const config of Object.values(configs) as any[]) {
            expect(config.workers_dev).toBe(false); expect(config.preview_urls).toBe(false);
            for (const value of ["send_email", "EMAIL_FROM", "CF_MONITOR_TOKEN", "CF_API_TOKEN", "budget:state", "pages_build_output_dir"]) expect(JSON.stringify(config)).not.toContain(value);
        }
        expect(validateDeploymentArtifacts(manifest, "test", configs, releaseSha)).toEqual([]);
    });
    it("rejects incomplete, duplicate, cross-environment or additional generated capabilities", () => {
        const missing = deploymentFixture(); missing.test.provisioned = false;
        expect(validateEnvironments(missing, { requireProvisioned: true }).join()).toContain("not been provisioned");
        const shared = deploymentFixture(); shared.test.releaseDatabase.id = shared.test.database.id;
        expect(validateEnvironments(shared).join()).toContain("Shared resource ID");
        const production = deploymentFixture(); production.production.state.id = production.test.state.id;
        expect(validateEnvironments(production).join()).toContain("disabled environment");
        const manifest = deploymentFixture(), configs = buildEnvironmentConfigs(manifest, "test", { releaseSha });
        configs.app.kv_namespaces.push({ binding: "OTHER", id: "f".repeat(32) });
        expect(validateDeploymentArtifacts(manifest, "test", configs, releaseSha).join()).toContain("differ");
    });
    it("keeps only enabled media isolation/cache rules and rejects changed policy artifacts", () => {
        const manifest = deploymentFixture(), policies = buildEdgePolicies(manifest);
        expect(Object.keys(policies)).toEqual(["mediaAccess", "mediaCache"]);
        expect(policies.mediaAccess.expression).toContain("test-store-media.vrclearn.com");
        expect(policies.mediaAccess.expression).not.toContain('http.host eq "store-media.vrclearn.com"');
        expect(validateEdgeArtifacts(manifest, policies)).toEqual([]);
        expect(validateEdgeArtifacts(manifest, { ...policies, emergencyDynamicStop: {} })).not.toEqual([]);
    });
    it("accepts Vite's compiled paths and empty normalized binding fields without accepting changed resources", () => {
        const manifest = deploymentFixture(), profile = { manifest, environment: "test" }, source = buildEnvironmentConfigs(manifest, "test", { releaseSha });
        for (const kind of ["app", "support"] as const) {
            const config = { ...source[kind], main: "index.js", no_bundle: true, d1_databases: source[kind].d1_databases.map((binding: any) => ({ ...binding, migrations_dir: "../../migrations" })), services: source[kind].services ?? [], ratelimits: source[kind].ratelimits ?? [], triggers: source[kind].triggers ?? {}, send_email: [], ...(kind === "app" ? { assets: { ...source.app.assets, directory: "../client" } } : {}) };
            const validate = kind === "app" ? validateBuiltApplication : validateBuiltSupport;
            expect(validate(profile, config)).toEqual([]);
            expect(validate(profile, { ...config, main: "../../worker/index.ts" }).join()).toContain("compiled output");
            expect(validate(profile, { ...config, send_email: [{ name: "EMAIL" }] }).join()).toContain("capability");
            expect(validate(profile, { ...config, routes: [{ pattern: "store.vrclearn.com", custom_domain: true }] }).join()).toContain("routes");
            config.d1_databases[0].database_id = "f".repeat(32);
            expect(validate(profile, config).join()).toContain("d1_databases");
        }
    });
    it("accepts only the exact expected remote branch head", () => {
        const execute = () => ({ status: 0, stdout: `${releaseSha}\trefs/heads/test\n` });
        expect(verifyRemoteHead("test", releaseSha, execute)).toBe(true);
        expect(verifyRemoteHead("main", releaseSha, execute)).toBe(false);
        expect(verifyRemoteHead("test", releaseSha, () => ({ status: 0, stdout: `${releaseSha}\trefs/heads/test/other` }))).toBe(false);
    });
});
