import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const environmentNames = ["production", "test"];
const identifier = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const edgeIdentifier = /^[a-f0-9]{32}$/;
const shaPattern = /^[a-f0-9]{40}$/;
export const workerFirstRoutes = JSON.parse(readFileSync(join(repositoryRoot, "shared/routes.json"), "utf8")).workerFirst;
export async function loadEnvironments(path = join(repositoryRoot, "deployment/environments.json")) { return JSON.parse(await readFile(path, "utf8")); }
function validId(value) { return typeof value === "string" && identifier.test(value) && !/^[0-]+$/.test(value); }
function validEdgeId(value) { return typeof value === "string" && edgeIdentifier.test(value) && !/^0+$/.test(value); }

export function validateEnvironments(manifest, { requireProvisioned = false, allowUnregisteredDurableObjects = false } = {}) {
    const errors = [], resources = [];
    if (manifest?.version !== 2) errors.push("Unsupported deployment manifest version");
    if (!validEdgeId(manifest?.accountId) || !validEdgeId(manifest?.zoneId)) errors.push("Configure a valid account and zone");
    if (manifest?.control || Object.values(manifest ?? {}).some((profile) => profile && typeof profile === "object" && profile.pages)) errors.push("Retired Pages and account-monitor configuration is forbidden");
    function resource(value, kind, owner, required) {
        if ((required || value != null) && !validId(value)) errors.push(`${owner}: configure a valid ${kind} ID`);
        if (value != null) resources.push({ value, kind, owner });
    }
    for (const environment of environmentNames) {
        const profile = manifest?.[environment];
        if (!profile) { errors.push(`Missing ${environment} profile`); continue; }
        const prefix = environment === "test" ? "test-" : "";
        const expected = { branch: environment === "test" ? "test" : "main", origin: `https://${prefix}store.vrclearn.com`, mediaOrigin: `https://${prefix}store-media.vrclearn.com`, privateBucket: `${prefix}vrclearn-store-private`, publicBucket: `${prefix}vrclearn-store-public` };
        for (const [key, value] of Object.entries(expected)) if (profile[key] !== value) errors.push(`${environment}: unexpected ${key}`);
        for (const [key, name] of Object.entries({ app: `${prefix}vrclearn-store`, support: `${prefix}vrclearn-store-support`, database: `${prefix}vrclearn-store`, state: `${prefix}vrclearn-store-state`, releaseDatabase: `${prefix}vrclearn-store-release-control` })) if (profile[key]?.name !== name) errors.push(`${environment}: unexpected ${key} resource name`);
        if (typeof profile.enabled !== "boolean" || typeof profile.provisioned !== "boolean") errors.push(`${environment}: declare enabled and provisioned explicitly`);
        if (environment === "production" && (profile.enabled !== false || profile.provisioned !== false)) errors.push("Production is not open and must remain disabled and unprovisioned");
        const required = requireProvisioned && profile.enabled;
        if (required && !profile.provisioned) errors.push(`${environment}: resources have not been provisioned`);
        for (const [value, kind] of [[profile.app?.id, "application Worker"], [profile.support?.id, "support Worker"], [profile.database?.id, "D1 database"], [profile.releaseDatabase?.id, "release control database"], [profile.state?.id, "STATE namespace"], [profile.access?.applicationId, "Access application"], [profile.access?.policyId, "Access policy"]]) resource(value, kind, environment, required);
        resource(profile.support?.doNamespaceId, "quota namespace", environment, required && !allowUnregisteredDurableObjects);
        if ((required || profile.support?.rateLimitNamespaceId != null) && !/^\d+$/.test(profile.support?.rateLimitNamespaceId ?? "")) errors.push(`${environment}: configure a numeric authentication rate-limit namespace`);
        if ((required || profile.turnstile?.siteKey != null) && (typeof profile.turnstile?.siteKey !== "string" || !profile.turnstile.siteKey.startsWith("0x"))) errors.push(`${environment}: configure a Turnstile site key`);
        if (environment === "test" && !profile.turnstile?.name?.startsWith("test-")) errors.push("Test Turnstile name must start with test-");
        for (const key of ["rulesetId", "mediaRuleId", "cacheRulesetId", "cacheRuleId"]) if ((required || profile.edge?.[key] != null) && !validEdgeId(profile.edge?.[key])) errors.push(`${environment}: configure ${key}`);
        if (!profile.enabled && [profile.app?.id, profile.support?.id, profile.database?.id, profile.releaseDatabase?.id, profile.state?.id, profile.support?.doNamespaceId, profile.support?.rateLimitNamespaceId, profile.access?.applicationId, profile.access?.policyId, profile.turnstile?.siteKey, ...Object.values(profile.edge ?? {})].some((value) => value != null)) errors.push(`${environment}: disabled environment cannot contain cloud resource identities`);
    }
    for (let index = 0; index < resources.length; index++) for (const other of resources.slice(index + 1)) if (resources[index].value === other.value) errors.push(`Shared resource ID between ${resources[index].owner}/${resources[index].kind} and ${other.owner}/${other.kind}`);
    if (manifest?.production?.support?.rateLimitNamespaceId != null && manifest.production.support.rateLimitNamespaceId === manifest?.test?.support?.rateLimitNamespaceId) errors.push("Authentication rate limits must be isolated");
    if (manifest?.production?.turnstile?.siteKey && manifest.production.turnstile.siteKey === manifest?.test?.turnstile?.siteKey) errors.push("Turnstile site keys must be isolated");
    return errors;
}
function ensureManifest(manifest, options) {
    const errors = validateEnvironments(manifest, options);
    if (errors.length) throw new Error(`Deployment configuration is incomplete:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
export async function loadDeployment(environment, { manifestPath, bootstrap = false } = {}) {
    if (!environmentNames.includes(environment)) throw new Error("Choose an explicit production or test deployment environment");
    const manifest = await loadEnvironments(manifestPath);
    if (environment !== "test" || manifest[environment]?.enabled !== true) throw new Error("DEPLOYMENT_DISABLED: production is not provisioned");
    ensureManifest(manifest, { requireProvisioned: !bootstrap, allowUnregisteredDurableObjects: bootstrap });
    const profile = manifest[environment];
    if (!profile.enabled || environment !== "test") throw new Error("DEPLOYMENT_DISABLED: production is not provisioned");
    return { environment, accountId: manifest.accountId, zoneId: manifest.zoneId, branch: profile.branch, appWorker: profile.app.name, appWorkerId: profile.app.id, supportWorker: profile.support.name, supportWorkerId: profile.support.id, d1DatabaseId: profile.database.id, stateId: profile.state.id, origin: profile.origin, mediaOrigin: profile.mediaOrigin, privateBucket: profile.privateBucket, publicBucket: profile.publicBucket, rateLimitNamespaceId: profile.support.rateLimitNamespaceId, turnstileSiteKey: profile.turnstile.siteKey, releaseDatabaseId: profile.releaseDatabase.id, profile, manifest };
}
export function buildEnvironmentConfigs(manifest, environment, { releaseSha, root = repositoryRoot, bootstrap = false } = {}) {
    ensureManifest(manifest, { requireProvisioned: !bootstrap, allowUnregisteredDurableObjects: bootstrap });
    const profile = manifest[environment];
    if (environment !== "test" || !profile?.enabled) throw new Error("DEPLOYMENT_DISABLED");
    if (!shaPattern.test(releaseSha ?? "")) throw new Error("A full immutable Git release SHA is required");
    const common = { compatibility_date: "2026-10-23", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false, d1_databases: [{ binding: "DB", database_name: profile.database.name, database_id: profile.database.id, migrations_dir: resolve(root, "migrations") }], r2_buckets: [{ binding: "PRIVATE_MEDIA", bucket_name: profile.privateBucket }, { binding: "PUBLIC_MEDIA", bucket_name: profile.publicBucket }], kv_namespaces: [{ binding: "STATE", id: profile.state.id }] };
    const runtime = { ORIGIN: profile.origin, MEDIA_ORIGIN: profile.mediaOrigin, ENVIRONMENT: "production", DEPLOYMENT_ENV: environment, RELEASE_SHA: releaseSha };
    return {
        app: { ...common, name: profile.app.name, main: resolve(root, "app/index.ts"), ...(bootstrap ? {} : { routes: [{ pattern: new URL(profile.origin).hostname, custom_domain: true }] }), limits: { cpu_ms: 50 }, observability: { enabled: true, head_sampling_rate: 0.01 }, assets: { directory: resolve(root, "dist/client"), binding: "ASSETS", not_found_handling: "404-page", html_handling: "drop-trailing-slash", run_worker_first: workerFirstRoutes }, secrets: { required: ["TURNSTILE_SECRET_KEY"] }, services: [{ binding: "AUTH", service: profile.support.name }], durable_objects: { bindings: [{ name: "QUOTA", class_name: "QuotaGate", script_name: profile.support.name }] }, vars: { ...runtime, TURNSTILE_SITE_KEY: profile.turnstile.siteKey } },
        support: { ...common, name: profile.support.name, main: resolve(root, "worker/index.ts"), limits: { cpu_ms: 500 }, triggers: { crons: ["*/15 * * * *"] }, observability: { enabled: true, head_sampling_rate: 0.01 }, secrets: { required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY"] }, vars: runtime, durable_objects: { bindings: [{ name: "QUOTA", class_name: "QuotaGate" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["QuotaGate"] }], ratelimits: [{ name: "AUTH_RATE_LIMIT", namespace_id: profile.support.rateLimitNamespaceId, simple: { limit: 20, period: 60 } }] },
    };
}
export async function generateDeployment(environment, { releaseSha, branch, workerName, outputDirectory, manifestPath, bootstrap = false } = {}) {
    const deployment = await loadDeployment(environment, { manifestPath, bootstrap });
    if (branch !== deployment.branch || workerName !== deployment.appWorker) throw new Error("The Worker identity and Git branch do not match the requested environment");
    const directory = resolve(outputDirectory ?? join(repositoryRoot, ".wrangler/deploy", environment));
    const configs = buildEnvironmentConfigs(deployment.manifest, environment, { releaseSha, bootstrap });
    await mkdir(directory, { recursive: true });
    const paths = { appConfigPath: join(directory, "app.jsonc"), supportConfigPath: join(directory, "support.jsonc") };
    for (const [kind, config] of Object.entries(configs)) await writeFile(paths[`${kind}ConfigPath`], JSON.stringify(config, null, 4) + "\n");
    return { ...paths, profile: deployment.profile };
}
export function buildEdgePolicies(manifest) {
    ensureManifest(manifest);
    const hosts = environmentNames.filter((name) => manifest[name].enabled).map((name) => new URL(manifest[name].mediaOrigin).hostname);
    const combine = (values) => values.length === 1 ? values[0] : `(${values.join(" or ")})`;
    return {
        mediaAccess: { action: "block", enabled: true, expression: combine(hosts.map((host) => `(http.host eq "${host}" and http.request.uri.path ne "/cdn-cgi/access/authorized" and (ip.src.country in {"XX" "T1"} or (ip.src.country eq "CN" and not starts_with(http.request.uri.path, "/cn/")) or (ip.src.country ne "CN" and not starts_with(http.request.uri.path, "/intl/"))))`)) },
        mediaCache: { action: "set_cache_settings", enabled: true, expression: combine(hosts.map((host) => `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/cn/") or starts_with(http.request.uri.path, "/intl/")))`)), action_parameters: { cache: true, edge_ttl: { mode: "bypass_by_default" }, browser_ttl: { mode: "respect_origin" } } },
    };
}
