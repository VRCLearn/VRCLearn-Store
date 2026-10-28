import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
// @ts-ignore Native Node deployment adapter.
import { createReleaseIO } from "../scripts/release-cloudflare.mjs";
// @ts-ignore Native Node deployment configuration.
import { buildEnvironmentConfigs, repositoryRoot } from "../scripts/environment.mjs";
import { deploymentContext, releaseSha, workerSettings } from "./deployment-fixture";

function fixture() {
    const profile = deploymentContext();
    const configs = buildEnvironmentConfigs(profile.manifest, "test", { releaseSha });
    const built = Object.fromEntries((["app", "support"] as const).map((kind) => [kind, {
        ...configs[kind], main: "index.js", no_bundle: true,
        ...(kind === "app" ? { assets: { ...configs.app.assets, directory: "../client" } } : {}),
    }]));
    const api = vi.fn(async (path: string) => {
        if (path.endsWith(`/d1/database/${profile.releaseDatabaseId}`)) return { uuid: profile.releaseDatabaseId, name: profile.profile.releaseDatabase.name };
        if (path.endsWith(`/d1/database/${profile.d1DatabaseId}`)) return { uuid: profile.d1DatabaseId, name: profile.profile.database.name };
        if (path.includes("/scripts-search?")) {
            const id = new URL(`https://example.com${path}`).searchParams.get("id");
            return [{ id, script_name: id === profile.appWorkerId ? profile.appWorker : profile.supportWorker }];
        }
        if (path.includes("/storage/kv/namespaces?")) return [{ id: profile.stateId, title: profile.profile.state.name }];
        const kind = path.includes(`/scripts/${profile.supportWorker}/`) ? "support" : "app";
        if (path.endsWith("/settings")) return workerSettings(profile, kind);
        if (path.endsWith("/deployments")) return { deployments: [{ versions: [{ version_id: `${kind}-version`, percentage: 100 }] }] };
        if (path.endsWith("/subdomain")) return { enabled: false, previews_enabled: false };
        throw new Error("Unexpected fixture API path");
    });
    const readConfiguration = vi.fn(async (path: string) => {
        const kind = path === resolve(repositoryRoot, "dist/support/wrangler.json") ? "support" : path === resolve(repositoryRoot, "dist/app/wrangler.json") ? "app" : undefined;
        if (!kind) throw new Error("Unexpected compiled configuration path");
        return built[kind];
    });
    const executeChild = vi.fn((_command: string, _args: string[], _options: { timeout: number; env: NodeJS.ProcessEnv }) => "");
    const variables = {
        CLOUDFLARE_API_TOKEN: "synthetic-release-token-only", CUSTOM_RELEASE_CONTEXT: "passed-environment",
        WRANGLER_CI_MATCH_TAG: profile.appWorkerId, WRANGLER_CI_OVERRIDE_NAME: profile.appWorker,
    };
    return { profile, built, api, readConfiguration, executeChild, variables, io: createReleaseIO(profile, variables, { api, readConfiguration, executeChild }) };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("coordinated deployment child identity", () => {
    it("targets each verified Worker without inheriting the connected app's CI name or tag", async () => {
        vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic-ambient-token-only");
        vi.stubEnv("UNRELATED_AMBIENT_RELEASE_VARIABLE", "must-not-be-inherited");
        const test = fixture();
        await test.io.verifyResourceIdentities();
        for (const kind of ["support", "app"] as const) {
            const result = await (kind === "support" ? test.io.deploySupport : test.io.deployApp)(releaseSha);
            expect(result).toMatchObject({ versionId: `${kind}-version`, sha: releaseSha, environment: "test" });
        }
        expect(test.executeChild).toHaveBeenCalledTimes(2);
        for (const [index, kind] of (["support", "app"] as const).entries()) {
            const [command, args, options] = test.executeChild.mock.calls[index];
            expect(command).toBe(process.execPath);
            expect(args).toEqual([resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", resolve(repositoryRoot, `dist/${kind}/wrangler.json`), "--strict"]);
            expect(options.timeout).toBeGreaterThan(0);
            expect(options.env.CUSTOM_RELEASE_CONTEXT).toBe("passed-environment");
            expect(options.env.CLOUDFLARE_API_TOKEN).toBe("synthetic-release-token-only");
            expect(options.env.UNRELATED_AMBIENT_RELEASE_VARIABLE).toBeUndefined();
            expect(options.env.CLOUDFLARE_ACCOUNT_ID).toBe(test.profile.accountId);
            expect(options.env.WRANGLER_CI_MATCH_TAG).toBe(kind === "support" ? test.profile.supportWorkerId : test.profile.appWorkerId);
            expect(options.env.WRANGLER_CI_OVERRIDE_NAME).toBe(kind === "support" ? test.profile.supportWorker : test.profile.appWorker);
            expect(options.env.WRANGLER_SEND_METRICS).toBe("false");
        }
        expect(test.variables.WRANGLER_CI_MATCH_TAG).toBe(test.profile.appWorkerId);
        expect(test.variables.WRANGLER_CI_OVERRIDE_NAME).toBe(test.profile.appWorker);
    });
    it("still rejects a changed compiled resource configuration before spawning Wrangler", async () => {
        const test = fixture();
        test.built.support.name = test.profile.appWorker;
        await expect(test.io.deploySupport(releaseSha)).rejects.toThrow("APP_BUILD_CONFIG_INVALID");
        expect(test.executeChild).not.toHaveBeenCalled();
    });
});
