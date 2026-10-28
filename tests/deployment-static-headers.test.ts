import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { buildStaticHeaders, staticBuildContext, validateStaticHeaders } from "../scripts/static-headers.mjs";
// @ts-expect-error deployment tooling uses native JavaScript modules
import { defaultConfigurationFiles } from "../scripts/preflight.mjs";

const template = readFileSync("public/_headers", "utf8");
const manifest = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
function imageSources(headers: string) {
    return /\bimg-src\s+([^;]+)/.exec(headers)?.[1].trim().split(/\s+/);
}

describe("static media content policy isolation", () => {
    it.each(["production", "test"])("allows only %s media from its environment manifest", async (environment) => {
        const context = await staticBuildContext({ DEPLOYMENT_ENV: environment });
        const headers = buildStaticHeaders(template, context.mediaOrigin);
        expect(imageSources(headers)).toEqual(["'self'", "data:", manifest[environment].mediaOrigin]);
        expect(headers).not.toContain(manifest[environment === "test" ? "production" : "test"].mediaOrigin);
        expect(headers).not.toContain("__STORE_MEDIA_ORIGIN__");
        expect(validateStaticHeaders(template, headers, context.mediaOrigin)).toEqual([]);
        const broadened = headers.replace(`data: ${context.mediaOrigin}`, `data: ${manifest.production.mediaOrigin} ${manifest.test.mediaOrigin}`);
        expect(validateStaticHeaders(template, broadened, context.mediaOrigin)).not.toEqual([]);
    });

    it("uses only same-origin and the configured loopback media address for local builds", async () => {
        const context = await staticBuildContext({});
        const local = JSON.parse(readFileSync("deployment/local-pages.jsonc", "utf8"));
        expect(context.environment).toBe("local");
        expect(imageSources(buildStaticHeaders(template, context.mediaOrigin))).toEqual(["'self'", "data:", local.vars.MEDIA_ORIGIN]);
        for (const name of ["production", "test"]) expect(buildStaticHeaders(template, context.mediaOrigin)).not.toContain(manifest[name].mediaOrigin);
    });

    it("rejects absent cloud identities, mismatched projects and unknown environments", async () => {
        await expect(staticBuildContext({ CF_PAGES: "1" })).rejects.toThrow("explicit");
        await expect(staticBuildContext({ WORKERS_CI_BRANCH: "test" })).rejects.toThrow("explicit");
        await expect(staticBuildContext({ DEPLOYMENT_ENV: "preview" })).rejects.toThrow("explicit");
        await expect(staticBuildContext({ DEPLOYMENT_ENV: "test", CF_PAGES: "1", CF_PAGES_BRANCH: "main", PAGES_PROJECT_NAME: "vrclearn-store" })).rejects.toThrow("project and branch");
        await expect(staticBuildContext({ DEPLOYMENT_ENV: "test", WORKERS_CI_BRANCH: "main", PAGES_PROJECT_NAME: "test-vrclearn-store" })).rejects.toThrow("project and branch");
        expect(await staticBuildContext({ DEPLOYMENT_ENV: "test", CF_PAGES: "1", CF_PAGES_BRANCH: "test", PAGES_PROJECT_NAME: "test-vrclearn-store" })).toEqual({ environment: "test", mediaOrigin: manifest.test.mediaOrigin });
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
