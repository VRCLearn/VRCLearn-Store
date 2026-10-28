import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { buildEdgePolicies, buildEnvironmentConfigs, loadEnvironments, repositoryRoot, validateEnvironments, workerFirstRoutes } from "./environment.mjs";
import { staticBuildContext, validateStaticHeaders } from "./static-headers.mjs";

export function defaultConfigurationFiles(root = repositoryRoot) {
    return ["", "worker"].flatMap((directory) => ["wrangler.json", "wrangler.jsonc", "wrangler.toml"].map((name) => resolve(root, directory, name))).filter(existsSync);
}
export function validateDeploymentArtifacts(manifest, environment, configs, releaseSha) {
    const errors = validateEnvironments(manifest, { requireProvisioned: true });
    if (errors.length) return errors;
    let expected; try { expected = buildEnvironmentConfigs(manifest, environment, { releaseSha }); } catch (error) { return [error.message]; }
    for (const kind of ["app", "support"]) if (!isDeepStrictEqual(configs[kind], expected[kind])) errors.push(`${kind}: generated bindings or configuration differ from the selected environment`);
    return errors;
}
function within(path, root) { const value = relative(root, path); return !value.startsWith("..") && !isAbsolute(value); }
export function validateBuiltApplication(profile, config, configPath = resolve(repositoryRoot, "dist/app/wrangler.json")) {
    return validateBuiltWorker(profile, config, "app", configPath);
}
export function validateBuiltSupport(profile, config, configPath = resolve(repositoryRoot, "dist/support/wrangler.json")) {
    return validateBuiltWorker(profile, config, "support", configPath);
}
function validateBuiltWorker(profile, config, kind, configPath) {
    const expected = buildEnvironmentConfigs(profile.manifest, profile.environment, { releaseSha: config.vars?.RELEASE_SHA })[kind];
    const errors = [];
    for (const key of ["name", "workers_dev", "preview_urls", "limits", "durable_objects", "vars", "r2_buckets", "kv_namespaces", "secrets"]) if (!isDeepStrictEqual(config[key], expected[key])) errors.push(`Built ${kind} differs at ${key}`);
    for (const key of ["services", "ratelimits", "routes"]) if (!isDeepStrictEqual(config[key] ?? [], expected[key] ?? [])) errors.push(`Built ${kind} differs at ${key}`);
    const databases = (config.d1_databases ?? []).map((binding) => ({ ...binding, migrations_dir: resolve(dirname(configPath), binding.migrations_dir) }));
    if (!isDeepStrictEqual(databases, expected.d1_databases)) errors.push(`Built ${kind} differs at d1_databases`);
    const assets = config.assets ?? {};
    if (kind === "app" && (assets.binding !== "ASSETS" || assets.not_found_handling !== "404-page" || assets.html_handling !== "drop-trailing-slash" || !isDeepStrictEqual(assets.run_worker_first, workerFirstRoutes) || !assets.directory || !within(resolve(dirname(configPath), assets.directory), resolve(repositoryRoot, "dist/client")))) errors.push("Built application asset routing or path differs");
    if (!config.main || !within(resolve(dirname(configPath), config.main), resolve(repositoryRoot, `dist/${kind}`)) || config.no_bundle !== true) errors.push(`Built ${kind} entrypoint is not the compiled output`);
    if (!isDeepStrictEqual(config.triggers ?? {}, expected.triggers ?? {}) || config.send_email?.length || config.previews || config.cache?.enabled || kind === "support" && config.assets) errors.push(`Unexpected ${kind} capability or cache`);
    return errors;
}
export function verifyRemoteHead(branch, expectedSha, execute = spawnSync) {
    if (!["main", "test"].includes(branch) || !/^[a-f0-9]{40}$/.test(expectedSha ?? "")) return false;
    try { const result = execute("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repositoryRoot, encoding: "utf8", timeout: 12000, windowsHide: true, maxBuffer: 16384 }); return result.status === 0 && !result.error && result.stdout.trim() === `${expectedSha}\trefs/heads/${branch}`; } catch { return false; }
}
export function validateEdgeArtifacts(manifest, policies) {
    try { const { description: _description, ...actual } = policies; return isDeepStrictEqual(actual, buildEdgePolicies(manifest)) ? [] : ["Edge policy artifact differs from enabled media hosts"]; } catch { return ["The media policy artifact or environment manifest is invalid"]; }
}
export async function runPreflight(variables = process.env) {
    const release = Boolean(variables.WORKERS_CI_COMMIT_SHA), manifest = await loadEnvironments();
    const errors = validateEnvironments(manifest, { requireProvisioned: release });
    if (defaultConfigurationFiles().length) errors.push("Use an explicit local or generated deployment configuration");
    try { errors.push(...validateEdgeArtifacts(manifest, JSON.parse(await readFile(resolve(repositoryRoot, "deployment/edge-policies.json"), "utf8")))); } catch { errors.push("The media policy artifact is unavailable"); }
    try { const context = await staticBuildContext(variables); const [template, headers] = await Promise.all([readFile(resolve(repositoryRoot, "public/_headers"), "utf8"), readFile(resolve(repositoryRoot, "dist/client/_headers"), "utf8")]); errors.push(...validateStaticHeaders(template, headers, context.mediaOrigin)); } catch { errors.push("The selected environment's generated static headers are unavailable or invalid"); }
    if (release && !errors.length) {
        const profile = manifest[variables.DEPLOYMENT_ENV];
        if (!profile?.enabled || variables.DEPLOYMENT_ENV !== "test" || variables.WORKERS_CI_BRANCH !== profile.branch || variables.WORKER_NAME !== profile.app.name || variables.WORKERS_CI_COMMIT_SHA !== variables.RELEASE_SHA) errors.push("Worker/branch/SHA deployment identity mismatch");
        else {
            try {
                const app = JSON.parse(await readFile(variables.VRCLEARN_APP_CONFIG, "utf8")), support = JSON.parse(await readFile(variables.VRCLEARN_SUPPORT_CONFIG, "utf8"));
                errors.push(...validateDeploymentArtifacts(manifest, "test", { app, support }, variables.RELEASE_SHA));
                const built = JSON.parse(await readFile(resolve(repositoryRoot, "dist/app/wrangler.json"), "utf8"));
                errors.push(...validateBuiltApplication({ manifest, environment: "test" }, built));
                const supportBuilt = JSON.parse(await readFile(resolve(repositoryRoot, "dist/support/wrangler.json"), "utf8"));
                errors.push(...validateBuiltSupport({ manifest, environment: "test" }, supportBuilt));
            } catch { errors.push("The generated Worker build configuration is unavailable"); }
            if (!verifyRemoteHead(profile.branch, variables.RELEASE_SHA)) errors.push("The release is no longer the remote branch HEAD");
        }
    }
    return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { const errors = await runPreflight(); if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; } else console.log("Local deployment configuration is internally consistent; remote verification is still required."); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
