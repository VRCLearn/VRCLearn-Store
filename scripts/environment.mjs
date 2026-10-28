import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const environmentNames = ["production", "test"];
const identifier = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const edgeIdentifier = /^[a-f0-9]{32}$/;
const sha = /^[a-f0-9]{40}$/;

export async function loadEnvironments(path = join(repositoryRoot, "deployment/environments.json")) {
    return JSON.parse(await readFile(path, "utf8"));
}

function validId(value) {
    return typeof value === "string" && identifier.test(value) && !/^[0-]+$/.test(value);
}
function validEdgeId(value) {
    return typeof value === "string" && edgeIdentifier.test(value) && !/^0+$/.test(value);
}

export function validateEnvironments(manifest, { requireProvisioned = true, allowUnregisteredDurableObjects = false } = {}) {
    const errors = [];
    if (manifest?.version !== 1) errors.push("Unsupported deployment manifest version");
    if (!validEdgeId(manifest?.accountId) || !validEdgeId(manifest?.zoneId)) errors.push("Configure a valid account and zone");
    const all = [];
    function resource(value, kind, owner, unregisteredDurableObject = false) {
        const pendingDurableObject = allowUnregisteredDurableObjects && unregisteredDurableObject && value == null;
        if (!pendingDurableObject && (requireProvisioned || value != null) && !validId(value)) errors.push(`${owner}: configure a valid ${kind} ID`);
        if (value !== null && value !== undefined) all.push({ value, kind, owner });
    }
    for (const environment of environmentNames) {
        const profile = manifest?.[environment];
        if (!profile) { errors.push(`Missing ${environment} profile`); continue; }
        const prefix = environment === "test" ? "test-" : "";
        const expected = {
            branch: environment === "test" ? "test" : "main",
            origin: `https://${prefix}store.vrclearn.com`,
            mediaOrigin: `https://${prefix}store-media.vrclearn.com`,
            pages: `${prefix}vrclearn-store`,
            support: `${prefix}vrclearn-store-support`,
            database: `${prefix}vrclearn-store`,
            state: environment === "production" ? "VRCLearn Store State" : "test-vrclearn-store-state",
            privateBucket: `${prefix}vrclearn-store-private`,
            publicBucket: `${prefix}vrclearn-store-public`,
            emailFrom: `${environment === "test" ? "test-" : ""}noreply@vrclearn.com`,
        };
        for (const key of ["branch", "origin", "mediaOrigin", "privateBucket", "publicBucket", "emailFrom"]) if (profile[key] !== expected[key]) errors.push(`${environment}: unexpected ${key}`);
        for (const key of ["pages", "support", "database", "state"]) if (profile[key]?.name !== expected[key]) errors.push(`${environment}: unexpected ${key} resource name`);
        resource(profile.pages?.id, "Pages project", environment);
        resource(profile.database?.id, "D1 database", environment);
        resource(profile.state?.id, "STATE namespace", environment);
        resource(profile.support?.doNamespaceId, "quota namespace", environment, true);
        resource(profile.access?.applicationId, "Access application", environment);
        resource(profile.access?.policyId, "Access policy", environment);
        if (!/^\d+$/.test(profile.support?.rateLimitNamespaceId ?? "")) errors.push(`${environment}: configure a numeric rate-limit namespace`);
        if ((requireProvisioned || profile.turnstile?.siteKey != null) && (typeof profile.turnstile?.siteKey !== "string" || !profile.turnstile.siteKey.startsWith("0x"))) errors.push(`${environment}: configure a Turnstile site key`);
        if (environment === "test" && !profile.turnstile?.name?.startsWith("test-")) errors.push("Test Turnstile name must start with test-");
        if (!validEdgeId(profile.edge?.rulesetId)) errors.push(`${environment}: configure the media and emergency ruleset`);
        resource(profile.edge?.dynamicRuleId, "dynamic emergency rule", environment);
        resource(profile.edge?.mediaRuleId, "media emergency rule", environment);
        for (const key of ["dynamicRuleId", "mediaRuleId"]) if (profile.edge?.[key] != null && !validEdgeId(profile.edge[key])) errors.push(`${environment}: invalid ${key}`);
    }
    const control = manifest?.control;
    if (control?.name !== "vrclearn-store-account-monitor" || control?.state?.name !== "vrclearn-store-account-state" || control?.releaseDatabase?.name !== "vrclearn-store-release-control") errors.push("Unexpected account control resource identity");
    resource(control?.state?.id, "authority STATE namespace", "control");
    resource(control?.doNamespaceId, "alert quota namespace", "control", true);
    resource(control?.releaseDatabase?.id, "release control database", "control");
    for (let index = 0; index < all.length; index++) {
        const current = all[index];
        for (const other of all.slice(index + 1)) {
            const sharedEmergencyRule = current.kind === other.kind && ["dynamic emergency rule", "media emergency rule"].includes(current.kind) && current.owner !== other.owner && environmentNames.includes(current.owner) && environmentNames.includes(other.owner);
            if (current.value === other.value && !sharedEmergencyRule) errors.push(`Shared resource ID between ${current.owner}/${current.kind} and ${other.owner}/${other.kind}`);
        }
    }
    if (manifest?.production?.support?.rateLimitNamespaceId === manifest?.test?.support?.rateLimitNamespaceId) errors.push("Business authentication rate limits must be isolated");
    if (manifest?.production?.turnstile?.siteKey && manifest.production.turnstile.siteKey === manifest?.test?.turnstile?.siteKey) errors.push("Business Turnstile site keys must be isolated");
    if (manifest?.production?.edge?.rulesetId !== manifest?.test?.edge?.rulesetId) errors.push("Account monitoring targets must share the configured zone ruleset");
    return errors;
}

function ensureManifest(manifest, options) {
    const errors = validateEnvironments(manifest, options);
    if (errors.length) throw new Error(`Deployment configuration is incomplete:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

export async function loadDeployment(environment, { manifestPath, bootstrap = false } = {}) {
    if (!environmentNames.includes(environment)) throw new Error("Choose an explicit production or test deployment environment");
    const manifest = await loadEnvironments(manifestPath);
    ensureManifest(manifest, { allowUnregisteredDurableObjects: bootstrap });
    const profile = manifest[environment];
    return {
        environment, accountId: manifest.accountId, zoneId: manifest.zoneId,
        branch: profile.branch, pagesProject: profile.pages.name, pagesProjectId: profile.pages.id,
        supportWorker: profile.support.name, d1DatabaseId: profile.database.id, stateId: profile.state.id,
        origin: profile.origin, mediaOrigin: profile.mediaOrigin,
        privateBucket: profile.privateBucket, publicBucket: profile.publicBucket,
        rateLimitNamespaceId: profile.support.rateLimitNamespaceId, turnstileSiteKey: profile.turnstile.siteKey,
        releaseDatabaseId: manifest.control.releaseDatabase.id, profile, manifest,
    };
}

export function buildEnvironmentConfigs(manifest, environment, { releaseSha, root = repositoryRoot, bootstrap = false } = {}) {
    if (!environmentNames.includes(environment)) throw new Error("Choose an explicit production or test deployment environment");
    ensureManifest(manifest, { allowUnregisteredDurableObjects: bootstrap });
    if (!sha.test(releaseSha ?? "")) throw new Error("A full immutable Git release SHA is required");
    const profile = manifest[environment];
    const common = {
        compatibility_date: "2026-10-26", compatibility_flags: ["nodejs_compat"],
        d1_databases: [{ binding: "DB", database_name: profile.database.name, database_id: profile.database.id, migrations_dir: resolve(root, "migrations") }],
        r2_buckets: [{ binding: "PRIVATE_MEDIA", bucket_name: profile.privateBucket }, { binding: "PUBLIC_MEDIA", bucket_name: profile.publicBucket }],
        kv_namespaces: [{ binding: "STATE", id: profile.state.id }],
    };
    const runtime = { ORIGIN: profile.origin, MEDIA_ORIGIN: profile.mediaOrigin, ENVIRONMENT: "production", DEPLOYMENT_ENV: environment, RELEASE_SHA: releaseSha };
    const pages = {
        ...common, name: profile.pages.name, pages_build_output_dir: resolve(root, "dist"), limits: { cpu_ms: 50 },
        services: [{ binding: "AUTH", service: profile.support.name }],
        durable_objects: { bindings: [{ name: "QUOTA", class_name: "QuotaGate", script_name: profile.support.name }] },
        vars: { ...runtime, PAGES_PROJECT_NAME: profile.pages.name, SKIP_DEPENDENCY_INSTALL: "1", TURNSTILE_SITE_KEY: profile.turnstile.siteKey, CF_ZONE_ID: manifest.zoneId },
    };
    const support = {
        ...common, name: profile.support.name, main: resolve(root, "worker/index.ts"), workers_dev: false, preview_urls: false,
        limits: { cpu_ms: 500 }, triggers: { crons: ["*/15 * * * *"] }, observability: { enabled: true, head_sampling_rate: 0.01 },
        secrets: { required: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY"] },
        vars: { ...runtime, EMAIL_FROM: profile.emailFrom },
        send_email: [{ name: "EMAIL", allowed_sender_addresses: [profile.emailFrom] }],
        durable_objects: { bindings: [{ name: "QUOTA", class_name: "QuotaGate" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["QuotaGate"] }],
        ratelimits: [{ name: "AUTH_RATE_LIMIT", namespace_id: profile.support.rateLimitNamespaceId, simple: { limit: 20, period: 60 } }],
    };
    const control = {
        name: manifest.control.name, main: resolve(root, "control/index.ts"), compatibility_date: "2026-10-26", compatibility_flags: ["nodejs_compat"],
        workers_dev: false, preview_urls: false, limits: { cpu_ms: 500 }, triggers: { crons: ["7,22,37,52 * * * *"] }, observability: { enabled: true, head_sampling_rate: 0.01 },
        secrets: { required: ["CF_MONITOR_TOKEN", "CF_API_TOKEN", "ALERT_EMAIL"] },
        kv_namespaces: [{ binding: "STATE", id: manifest.control.state.id }, { binding: "PRODUCTION_STATE", id: manifest.production.state.id }, { binding: "TEST_STATE", id: manifest.test.state.id }],
        send_email: [{ name: "EMAIL", allowed_sender_addresses: [manifest.control.emailFrom] }],
        durable_objects: { bindings: [{ name: "QUOTA", class_name: "QuotaGate" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["QuotaGate"] }],
        vars: {
            ENVIRONMENT: "production", EMAIL_FROM: manifest.control.emailFrom, CF_ACCOUNT_ID: manifest.accountId, CF_ZONE_ID: manifest.zoneId,
            EDGE_RULESET_ID: manifest.production.edge.rulesetId,
            ...Object.fromEntries(environmentNames.flatMap((name) => {
                const target = manifest[name];
                return [[`${name.toUpperCase()}_ORIGIN`, target.origin], [`${name.toUpperCase()}_MEDIA_ORIGIN`, target.mediaOrigin], [`${name.toUpperCase()}_EDGE_RULE_ID`, target.edge.dynamicRuleId], [`${name.toUpperCase()}_EDGE_MEDIA_RULE_ID`, target.edge.mediaRuleId]];
            })),
        },
    };
    return { pages, support, control };
}

export async function generateDeployment(environment, { releaseSha, branch, projectName, outputDirectory, manifestPath, redirect = false, bootstrap = false } = {}) {
    const deployment = await loadDeployment(environment, { manifestPath, bootstrap });
    if (branch !== deployment.branch || projectName !== deployment.pagesProject) throw new Error("The project identity and Git branch do not match the requested environment");
    const directory = resolve(outputDirectory ?? join(repositoryRoot, ".wrangler/deploy", environment));
    const configs = buildEnvironmentConfigs(deployment.manifest, environment, { releaseSha, bootstrap });
    await mkdir(directory, { recursive: true });
    const paths = { pagesConfigPath: join(directory, "pages.jsonc"), supportConfigPath: join(directory, "support.jsonc"), controlConfigPath: join(directory, "control.jsonc") };
    for (const [kind, config] of Object.entries(configs)) await writeFile(paths[`${kind}ConfigPath`], JSON.stringify(config, null, 4) + "\n");
    if (redirect) {
        const redirectDirectory = join(repositoryRoot, ".wrangler/deploy");
        await mkdir(redirectDirectory, { recursive: true });
        await writeFile(join(redirectDirectory, "config.json"), JSON.stringify({ configPath: relative(redirectDirectory, paths.pagesConfigPath).replaceAll("\\", "/") }) + "\n");
    }
    return { ...paths, profile: deployment.profile };
}

export async function preparePagesBuild(environment = process.env.DEPLOYMENT_ENV, variables = process.env) {
    if (variables.CF_PAGES !== "1") throw new Error("Pages configuration preparation requires a native Cloudflare Pages build");
    if (variables.CF_PAGES_COMMIT_SHA !== variables.RELEASE_SHA || !sha.test(variables.RELEASE_SHA ?? "")) throw new Error("Pages branch HEAD does not match the coordinated release SHA");
    return generateDeployment(environment, { releaseSha: variables.RELEASE_SHA, branch: variables.CF_PAGES_BRANCH, projectName: variables.PAGES_PROJECT_NAME, redirect: true });
}

export function buildEdgePolicies(manifest) {
    ensureManifest(manifest, { allowUnregisteredDurableObjects: true });
    const sharedExpression = (origins, expression) => {
        const expressions = [...new Set(origins)].sort().map((origin) => expression(new URL(origin).hostname));
        return expressions.length === 1 ? expressions[0] : `(${expressions.join(" or ")})`;
    };
    const sites = environmentNames.map((name) => manifest[name].origin);
    const media = environmentNames.map((name) => manifest[name].mediaOrigin);
    return {
        mediaAccess: { action: "block", enabled: true, expression: sharedExpression(media, (host) => `(http.host eq "${host}" and http.request.uri.path ne "/cdn-cgi/access/authorized" and (ip.src.country in {"XX" "T1"} or (ip.src.country eq "CN" and not starts_with(http.request.uri.path, "/cn/")) or (ip.src.country ne "CN" and not starts_with(http.request.uri.path, "/intl/"))))`) },
        emergencyDynamicStop: { action: "block", enabled: false, expression: sharedExpression(sites, (host) => `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/api/") or http.request.uri.path contains "/products/" or http.request.uri.path contains "/shops/" or http.request.uri.path eq "/sitemap.xml" or starts_with(http.request.uri.path, "/sitemaps/")))`) },
        emergencyMediaStop: { action: "block", enabled: false, expression: sharedExpression(media, (host) => `http.host eq "${host}"`) },
        mediaCache: { action: "set_cache_settings", enabled: true, expression: sharedExpression(media, (host) => `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/cn/") or starts_with(http.request.uri.path, "/intl/")))`), action_parameters: { cache: true, edge_ttl: { mode: "bypass_by_default" }, browser_ttl: { mode: "respect_origin" } } },
    };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        if (process.argv[2] !== "prepare-pages") throw new Error("Use environment.mjs prepare-pages inside a native Pages build");
        const result = await preparePagesBuild();
        console.log(`Generated isolated Pages configuration at ${relative(repositoryRoot, result.pagesConfigPath)}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
