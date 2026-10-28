import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEdgePolicies, buildEnvironmentConfigs, loadEnvironments, repositoryRoot, validateEnvironments } from "./environment.mjs";

export function validateDeploymentArtifacts(manifest, environment, configs, releaseSha) {
    const errors = validateEnvironments(manifest);
    if (errors.length) return errors;
    let expected;
    try { expected = buildEnvironmentConfigs(manifest, environment, { releaseSha }); }
    catch (error) { return [error.message]; }
    for (const kind of ["pages", "support", "control"]) {
        if (!isDeepStrictEqual(configs[kind], expected[kind])) errors.push(`${kind}: generated bindings or configuration differ from the selected environment`);
    }
    return errors;
}

export function verifyRemoteHead(branch, expectedSha, execute = spawnSync) {
    if (!["main", "test"].includes(branch) || !/^[a-f0-9]{40}$/.test(expectedSha ?? "")) return false;
    const ref = `refs/heads/${branch}`;
    try {
        const result = execute("git", ["ls-remote", "origin", ref], { cwd: repositoryRoot, encoding: "utf8", timeout: 12_000, windowsHide: true, maxBuffer: 16_384 });
        return result.status === 0 && !result.error && result.stdout.trim() === `${expectedSha}\t${ref}`;
    } catch { return false; }
}

export function validateEdgeArtifacts(manifest, policies) {
    try {
        const { description: _description, ...actual } = policies;
        return isDeepStrictEqual(actual, buildEdgePolicies(manifest)) ? [] : ["Edge policy artifact differs from the configured environment hosts"];
    } catch { return ["The shared edge policy artifact or environment manifest is invalid"]; }
}

export async function runPreflight(variables = process.env) {
    const manifest = await loadEnvironments();
    const errors = validateEnvironments(manifest);
    if (!errors.length) {
        try { errors.push(...validateEdgeArtifacts(manifest, JSON.parse(await readFile(resolve(repositoryRoot, "deployment/edge-policies.json"), "utf8")))); }
        catch { errors.push("The shared edge policy artifact is unavailable"); }
    }
    if (variables.CF_PAGES === "1") {
        const environment = variables.DEPLOYMENT_ENV;
        const profile = manifest[environment];
        if (!profile || !["production", "test"].includes(environment)) errors.push("The Pages project must identify its deployment environment");
        else if (variables.CF_PAGES_BRANCH !== profile.branch || variables.PAGES_PROJECT_NAME !== profile.pages.name) errors.push("Pages project/branch identity does not match the deployment environment");
        if (!/^[a-f0-9]{40}$/.test(variables.RELEASE_SHA ?? "") || variables.CF_PAGES_COMMIT_SHA !== variables.RELEASE_SHA) errors.push("Pages checkout does not match the coordinated immutable release SHA");
        if (!errors.length) {
            try {
                const redirectFile = resolve(repositoryRoot, ".wrangler/deploy/config.json");
                const redirect = JSON.parse(await readFile(redirectFile, "utf8"));
                const pagesPath = resolve(dirname(redirectFile), redirect.configPath ?? "");
                const directory = dirname(pagesPath);
                const configs = {
                    pages: JSON.parse(await readFile(pagesPath, "utf8")),
                    support: JSON.parse(await readFile(resolve(directory, "support.jsonc"), "utf8")),
                    control: JSON.parse(await readFile(resolve(directory, "control.jsonc"), "utf8")),
                };
                errors.push(...validateDeploymentArtifacts(manifest, environment, configs, variables.RELEASE_SHA));
            } catch { errors.push("The isolated generated Pages deployment configuration is unavailable"); }
        }
        if (!errors.length && !verifyRemoteHead(profile.branch, variables.RELEASE_SHA)) errors.push("The coordinated release is no longer the remote branch HEAD, or remote verification failed");
    }
    return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        const errors = await runPreflight();
        if (errors.length) { console.error(`Deployment configuration is incomplete:\n${errors.map((error) => `- ${error}`).join("\n")}`); process.exitCode = 1; }
        else console.log("Both environment manifests are isolated and internally consistent. Remote bindings, access, billing and deployment still require verification.");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
