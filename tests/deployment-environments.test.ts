import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sharedDynamicBlockExpression, sharedMediaBlockExpression } from "../control/monitor";
// Deployment modules intentionally run in Node, outside the application bundle.
// @ts-expect-error deployment tooling uses native JavaScript modules
import { buildEdgePolicies, buildEnvironmentConfigs, generateDeployment, preparePagesBuild, validateEnvironments } from "../scripts/environment.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { validateDeploymentArtifacts, validateEdgeArtifacts, verifyRemoteHead } from "../scripts/preflight.mjs";

function fixture() {
    const manifest = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
    let counter = 500;
    const id = () => (++counter).toString(16).padStart(32, "a");
    for (const environment of ["production", "test"]) {
        const profile = manifest[environment];
        for (const [target, key] of [[profile.pages, "id"], [profile.database, "id"], [profile.state, "id"], [profile.support, "doNamespaceId"], [profile.access, "applicationId"], [profile.access, "policyId"], [profile.edge, "dynamicRuleId"], [profile.edge, "mediaRuleId"]]) target[key] ??= id();
        profile.turnstile.siteKey ??= `0x-test-${environment}`;
    }
    manifest.control.state.id ??= id();
    manifest.control.doNamespaceId ??= id();
    manifest.control.releaseDatabase.id ??= id();
    return manifest;
}
const releaseSha = "a".repeat(40);

describe("business environment isolation", () => {
    it("generates cloud test bindings with production security and no production business resources or control tokens", () => {
        const manifest = fixture();
        expect(validateEnvironments(manifest)).toEqual([]);
        const configs = buildEnvironmentConfigs(manifest, "test", { releaseSha });
        for (const config of [configs.pages, configs.support]) {
            expect(config.vars).toMatchObject({ ENVIRONMENT: "production", DEPLOYMENT_ENV: "test", RELEASE_SHA: releaseSha });
            const serialized = JSON.stringify(config);
            for (const value of [manifest.production.database.id, manifest.production.state.id, manifest.production.support.name, manifest.production.origin, manifest.production.privateBucket, manifest.production.publicBucket, "CF_API_TOKEN", "CF_MONITOR_TOKEN", "ALERT_EMAIL"]) expect(serialized).not.toContain(JSON.stringify(value));
        }
        expect(configs.support.secrets.required).toEqual(["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY"]);
        expect(configs.control.kv_namespaces).toEqual([
            { binding: "STATE", id: manifest.control.state.id },
            { binding: "PRODUCTION_STATE", id: manifest.production.state.id },
            { binding: "TEST_STATE", id: manifest.test.state.id },
        ]);
        expect(validateDeploymentArtifacts(manifest, "test", configs, releaseSha)).toEqual([]);
    });

    it.each(["database", "state", "support", "pages", "access"])("rejects a test %s resource sharing a production target", (kind) => {
        const manifest = fixture();
        const key = { database: "id", state: "id", support: "doNamespaceId", pages: "id", access: "applicationId" }[kind]!;
        manifest.test[kind][key] = manifest.production[kind][key];
        expect(validateEnvironments(manifest).some((message: string) => message.includes("Shared resource ID"))).toBe(true);
    });

    it("allows sharing only the same kind of emergency rule between the two environments", () => {
        const manifest = fixture();
        manifest.test.edge.dynamicRuleId = manifest.production.edge.dynamicRuleId;
        manifest.test.edge.mediaRuleId = manifest.production.edge.mediaRuleId;
        expect(validateEnvironments(manifest)).toEqual([]);
        manifest.test.edge.mediaRuleId = manifest.production.edge.dynamicRuleId;
        expect(validateEnvironments(manifest).some((message: string) => message.includes("Shared resource ID"))).toBe(true);
        manifest.test.edge.mediaRuleId = manifest.production.edge.mediaRuleId;
        manifest.test.state.id = manifest.production.edge.dynamicRuleId;
        expect(validateEnvironments(manifest).some((message: string) => message.includes("Shared resource ID"))).toBe(true);
    });

    it.each(["branch", "origin", "mediaOrigin", "privateBucket", "publicBucket", "emailFrom"])("rejects production %s selected by the test environment", (key) => {
        const manifest = fixture();
        manifest.test[key] = manifest.production[key];
        expect(validateEnvironments(manifest)).not.toEqual([]);
    });

    it("rejects shared rate-limit, challenge, control-state and release-control resources", () => {
        for (const mutation of [
            (manifest: ReturnType<typeof fixture>) => { manifest.test.support.rateLimitNamespaceId = manifest.production.support.rateLimitNamespaceId; },
            (manifest: ReturnType<typeof fixture>) => { manifest.test.turnstile.siteKey = manifest.production.turnstile.siteKey; },
            (manifest: ReturnType<typeof fixture>) => { manifest.control.state.id = manifest.test.state.id; },
            (manifest: ReturnType<typeof fixture>) => { manifest.control.releaseDatabase.id = manifest.production.database.id; },
        ]) {
            const manifest = fixture();
            mutation(manifest);
            expect(validateEnvironments(manifest)).not.toEqual([]);
        }
    });

    it("never chooses an implicit environment or permits an unknown release SHA", () => {
        const manifest = fixture();
        for (const environment of [undefined, "development", "preview", "staging"]) expect(() => buildEnvironmentConfigs(manifest, environment, { releaseSha })).toThrow("explicit");
        expect(() => buildEnvironmentConfigs(manifest, "test", { releaseSha: "main" })).toThrow("immutable");
    });

    it("rejects unprovisioned targets and deployed artifact drift", () => {
        const manifest = fixture();
        manifest.test.database.id = null;
        expect(validateEnvironments(manifest)).not.toEqual([]);
        expect(validateEnvironments(manifest, { requireProvisioned: false })).toEqual([]);
        const provisioned = fixture();
        const configs = buildEnvironmentConfigs(provisioned, "test", { releaseSha });
        configs.pages.d1_databases[0].database_id = provisioned.production.database.id;
        expect(validateDeploymentArtifacts(provisioned, "test", configs, releaseSha)).toContain("pages: generated bindings or configuration differ from the selected environment");
    });

    it("allows only first-deploy DO registration to be pending in explicit bootstrap generation", () => {
        const manifest = fixture();
        manifest.test.support.doNamespaceId = null;
        manifest.control.doNamespaceId = null;
        expect(() => buildEnvironmentConfigs(manifest, "test", { releaseSha })).toThrow("quota namespace");
        expect(() => buildEnvironmentConfigs(manifest, "test", { releaseSha, bootstrap: true })).not.toThrow();
        manifest.test.database.id = null;
        expect(() => buildEnvironmentConfigs(manifest, "test", { releaseSha, bootstrap: true })).toThrow("D1 database");
    });

    it("generates shared region, shutdown and cache policies covering exactly both environment hosts", () => {
        const manifest = fixture();
        const policies = buildEdgePolicies(manifest);
        expect(policies.mediaAccess.enabled).toBe(true);
        expect(policies.emergencyDynamicStop.enabled).toBe(false);
        expect(policies.emergencyMediaStop.enabled).toBe(false);
        expect(policies.mediaAccess.expression).toContain("/cdn-cgi/access/authorized");
        expect(policies.emergencyDynamicStop.expression).toBe(sharedDynamicBlockExpression([manifest.production.origin, manifest.test.origin]));
        expect(policies.emergencyMediaStop.expression).toBe(sharedMediaBlockExpression([manifest.production.mediaOrigin, manifest.test.mediaOrigin]));
        for (const key of ["mediaAccess", "emergencyMediaStop", "mediaCache"]) {
            expect(policies[key].expression).toContain('http.host eq "store-media.vrclearn.com"');
            expect(policies[key].expression).toContain('http.host eq "test-store-media.vrclearn.com"');
            expect(policies[key].expression).not.toContain('http.host eq "store.vrclearn.com"');
        }
        expect(policies.emergencyDynamicStop.expression).toContain('http.host eq "store.vrclearn.com"');
        expect(policies.emergencyDynamicStop.expression).toContain('http.host eq "test-store.vrclearn.com"');
        expect(validateEdgeArtifacts(manifest, policies)).toEqual([]);
        expect(validateEdgeArtifacts(manifest, JSON.parse(readFileSync("deployment/edge-policies.json", "utf8")))).toEqual([]);
        policies.emergencyMediaStop.expression = 'http.host eq "unrelated.vrclearn.com"';
        expect(validateEdgeArtifacts(manifest, policies)).not.toEqual([]);
        manifest.test.origin = "https://unrelated.vrclearn.com";
        expect(() => buildEdgePolicies(manifest)).toThrow("unexpected origin");
    });

    it("requires the fixed project and branch together before writing deployment artifacts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "vrclearn-environment-"));
        try {
            const manifestPath = join(directory, "environments.json");
            await writeFile(manifestPath, JSON.stringify(fixture()));
            const options = { manifestPath, outputDirectory: join(directory, "generated"), releaseSha, branch: "test", projectName: "test-vrclearn-store" };
            await expect(generateDeployment("test", { ...options, branch: "main" })).rejects.toThrow("identity");
            await expect(generateDeployment("test", { ...options, projectName: "vrclearn-store" })).rejects.toThrow("identity");
            const result = await generateDeployment("test", options);
            const pages = JSON.parse(await readFile(result.pagesConfigPath, "utf8"));
            const support = JSON.parse(await readFile(result.supportConfigPath, "utf8"));
            expect(pages.name).toBe("test-vrclearn-store");
            expect(pages.vars.PAGES_PROJECT_NAME).toBe("test-vrclearn-store");
            expect(support.name).toBe("test-vrclearn-store-support");
        } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it("rejects non-Pages preparation and a moving branch HEAD before loading deployment resources", async () => {
        await expect(preparePagesBuild("test", {})).rejects.toThrow("native Cloudflare Pages");
        await expect(preparePagesBuild("test", { CF_PAGES: "1", CF_PAGES_COMMIT_SHA: "b".repeat(40), RELEASE_SHA: releaseSha })).rejects.toThrow("HEAD");
    });

    it("checks remote HEAD with a bounded exact-ref lookup and rejects stale or ambiguous results", () => {
        const execute = (command: string, args: string[], options: Record<string, unknown>) => {
            expect(command).toBe("git");
            expect(args).toEqual(["ls-remote", "origin", "refs/heads/test"]);
            expect(options).toMatchObject({ timeout: 12_000, maxBuffer: 16_384, windowsHide: true });
            return { status: 0, stdout: `${releaseSha}\trefs/heads/test\n` };
        };
        expect(verifyRemoteHead("test", releaseSha, execute)).toBe(true);
        expect(verifyRemoteHead("preview", releaseSha, execute)).toBe(false);
        for (const result of [
            { status: 0, stdout: `${"b".repeat(40)}\trefs/heads/test\n` },
            { status: 0, stdout: `${releaseSha}\trefs/heads/main\n` },
            { status: 0, stdout: `${releaseSha}\trefs/heads/test\n${releaseSha}\trefs/heads/main\n` },
            { status: 0, stdout: "" },
            { status: 1, stdout: `${releaseSha}\trefs/heads/test\n` },
            { status: null, error: new Error("timed out"), stdout: "" },
        ]) expect(verifyRemoteHead("test", releaseSha, () => result)).toBe(false);
        expect(verifyRemoteHead("test", releaseSha, () => { throw new Error("unavailable"); })).toBe(false);
    });
});
