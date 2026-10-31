import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { buildStaticHeaders, staticBuildContext, validateStaticHeaders } from "../scripts/static-headers.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { defaultConfigurationFiles } from "../scripts/preflight.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { buildEnvironmentConfigs } from "../scripts/environment.mjs";

const template = readFileSync("public/_headers", "utf8");
const manifest = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
function imageSources(headers: string) {
    return /\bimg-src\s+([^;]+)/.exec(headers)?.[1].trim().split(/\s+/);
}
async function cloudFixture() {
    const directory = await mkdtemp(join(tmpdir(), "vrclearn-static-cloud-"));
    const configured = structuredClone(manifest);
    let sequence = 200;
    const id = () => (++sequence).toString(16).padStart(32, "a");
    const profile = configured.test;
    profile.provisioned = true;
    for (const target of [profile.app, profile.support, profile.database, profile.state, profile.releaseDatabase]) target.id = id();
    profile.support.doNamespaceId = id();
    profile.support.rateLimitNamespaceId = "2026102902";
    profile.turnstile.siteKey = "0x-test-static-policy";
    profile.access.applicationId = id();
    profile.access.policyId = id();
    for (const key of Object.keys(profile.edge)) profile.edge[key] = id();
    const sha = "a".repeat(40);
    const manifestPath = join(directory, "environments.json");
    const appConfigPath = join(directory, "app.jsonc");
    await writeFile(manifestPath, JSON.stringify(configured));
    const config = buildEnvironmentConfigs(configured, "test", { releaseSha: sha }).app;
    await writeFile(appConfigPath, JSON.stringify(config));
    return { directory, config, manifestPath, appConfigPath, variables: { DEPLOYMENT_ENV: "test", WORKERS_CI_BRANCH: "test", WORKERS_CI_COMMIT_SHA: sha, WORKER_NAME: "test-vrclearn-store", RELEASE_SHA: sha, VRCLEARN_APP_CONFIG: appConfigPath } };
}

describe("static media content policy isolation", () => {
    it("allows Google font files without granting stylesheet, script or connection access", () => {
        const headers = buildStaticHeaders(template, "https://test-store-media.vrclearn.com");
        expect(/\bstyle-src\s+([^;]+)/.exec(headers)?.[1].trim().split(/\s+/)).toEqual(["'self'", "'unsafe-inline'"]);
        expect(/\bfont-src\s+([^;]+)/.exec(headers)?.[1].trim().split(/\s+/)).toEqual(["'self'", "https://fonts.gstatic.com"]);
        for (const directive of ["script-src", "connect-src"]) expect(new RegExp(`\\b${directive}\\s+([^;]+)`).exec(headers)?.[1]).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    });

    it("allows only the enabled test environment's media origin", async () => {
        const fixture = await cloudFixture();
        try {
            const context = await staticBuildContext(fixture.variables, { manifestPath: fixture.manifestPath });
            const headers = buildStaticHeaders(template, context.mediaOrigin);
            expect(imageSources(headers)).toEqual(["'self'", "data:", manifest.test.mediaOrigin]);
            expect(headers).not.toContain(manifest.production.mediaOrigin);
            expect(headers).not.toContain("__STORE_MEDIA_ORIGIN__");
            expect(validateStaticHeaders(template, headers, context.mediaOrigin)).toEqual([]);
            const broadened = headers.replace(`data: ${context.mediaOrigin}`, `data: ${manifest.production.mediaOrigin} ${manifest.test.mediaOrigin}`);
            expect(validateStaticHeaders(template, broadened, context.mediaOrigin)).not.toEqual([]);
            await expect(staticBuildContext({ ...fixture.variables, DEPLOYMENT_ENV: "production" }, { manifestPath: fixture.manifestPath })).rejects.toThrow("DEPLOYMENT_DISABLED");
        } finally { await rm(fixture.directory, { recursive: true, force: true }); }
    });

    it("uses only same-origin and the configured loopback media address for local builds", async () => {
        const context = await staticBuildContext({});
        const local = JSON.parse(readFileSync("deployment/local-app.jsonc", "utf8"));
        expect(context.environment).toBe("local");
        expect(imageSources(buildStaticHeaders(template, context.mediaOrigin))).toEqual(["'self'", "data:", local.vars.MEDIA_ORIGIN]);
        for (const name of ["production", "test"]) expect(buildStaticHeaders(template, context.mediaOrigin)).not.toContain(manifest[name].mediaOrigin);
    });

    it("rejects absent cloud identities, mismatched projects and unknown environments", async () => {
        await expect(staticBuildContext({ WORKERS_CI_BRANCH: "test" })).rejects.toThrow("explicit");
        await expect(staticBuildContext({ WORKER_NAME: "test-vrclearn-store" })).rejects.toThrow("explicit");
        await expect(staticBuildContext({ DEPLOYMENT_ENV: "preview" })).rejects.toThrow("explicit");
        const fixture = await cloudFixture();
        try {
            await expect(staticBuildContext({ ...fixture.variables, WORKERS_CI_BRANCH: "main" }, { manifestPath: fixture.manifestPath })).rejects.toThrow("Worker and branch");
            await expect(staticBuildContext({ ...fixture.variables, WORKER_NAME: "vrclearn-store" }, { manifestPath: fixture.manifestPath })).rejects.toThrow("Worker and branch");
            await expect(staticBuildContext({ ...fixture.variables, WORKERS_CI_COMMIT_SHA: "b".repeat(40) }, { manifestPath: fixture.manifestPath })).rejects.toThrow("immutable release SHA");
            fixture.config.vars.MEDIA_ORIGIN = manifest.production.mediaOrigin;
            await writeFile(fixture.appConfigPath, JSON.stringify(fixture.config));
            await expect(staticBuildContext(fixture.variables, { manifestPath: fixture.manifestPath })).rejects.toThrow("generated Worker configuration");
        } finally { await rm(fixture.directory, { recursive: true, force: true }); }
    });

    it("rejects cloud origins hidden in a local configuration and malformed templates", async () => {
        const directory = await mkdtemp(join(tmpdir(), "vrclearn-static-policy-"));
        try {
            const localConfigPath = join(directory, "local.jsonc");
            await writeFile(localConfigPath, JSON.stringify({ vars: { ENVIRONMENT: "development", DEPLOYMENT_ENV: "local", MEDIA_ORIGIN: manifest.production.mediaOrigin } }));
            await expect(staticBuildContext({}, { localConfigPath })).rejects.toThrow("cloud media");
            expect(() => buildStaticHeaders(template.replace("__STORE_MEDIA_ORIGIN__", ""), manifest.test.mediaOrigin)).toThrow("exactly one");
            expect(() => buildStaticHeaders(template + "__STORE_MEDIA_ORIGIN__", manifest.test.mediaOrigin)).toThrow("exactly one");
            expect(() => buildStaticHeaders(template, "https://test-store-media.vrclearn.com; img-src *")).toThrow();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});

describe("explicit Wrangler configuration selection", () => {
    it("keeps the repository free from auto-detected root or worker configurations", () => {
        expect(defaultConfigurationFiles()).toEqual([]);
    });

    it("detects all auto-detected configuration names even if they contain local bindings", async () => {
        const directory = await mkdtemp(join(tmpdir(), "vrclearn-default-config-"));
        try {
            await mkdir(join(directory, "worker"));
            const forbidden = ["wrangler.json", "wrangler.jsonc", "wrangler.toml", "worker/wrangler.json", "worker/wrangler.jsonc", "worker/wrangler.toml"];
            for (const path of forbidden) await writeFile(join(directory, path), "{}");
            expect(defaultConfigurationFiles(directory).sort()).toEqual(forbidden.map((path) => join(directory, path)).sort());
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
