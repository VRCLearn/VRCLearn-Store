import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateDeployment, repositoryRoot } from "./environment.mjs";
import { releaseLimits, ReleaseFailure } from "./release-core.mjs";

function child(command, args, { timeout = 180000, env = process.env } = {}) {
    const result = spawnSync(command, args, { cwd: repositoryRoot, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("RELEASE_CHILD_FAILED");
    return result.stdout.trim();
}

export function gitIdentity(variables = process.env) {
    const sha = child("git", ["rev-parse", "HEAD"], { timeout: 10000 });
    return {
        sha, branch: variables.WORKERS_CI_BRANCH, platformSha: variables.WORKERS_CI_COMMIT_SHA,
        projectName: variables.PAGES_PROJECT_NAME,
        dirty: Boolean(child("git", ["status", "--porcelain", "--untracked-files=no"], { timeout: 10000 })),
    };
}

export function createCloudflareClient(token, transport = fetch, remainingMs = () => releaseLimits.requestMs) {
    if (typeof token !== "string" || token.length < 20) throw new Error("RELEASE_TOKEN_MISSING");
    return async function cloudflare(path, { method = "GET", body, write = method !== "GET" } = {}) {
        if (!path.startsWith("/accounts/") || path.includes("..") || path.includes("?token=")) throw new Error("RELEASE_API_PATH_REJECTED");
        const headers = { Authorization: `Bearer ${token}` };
        if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
        let response;
        try {
            response = await transport(`https://api.cloudflare.com/client/v4${path}`, {
                method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
                redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(releaseLimits.requestMs, remainingMs()))),
            });
        } catch { throw new ReleaseFailure(write ? "CLOUDFLARE_WRITE_UNCONFIRMED" : "CLOUDFLARE_READ_FAILED", "api", write); }
        let payload;
        try { payload = await response.json(); }
        catch { throw new ReleaseFailure(write ? "CLOUDFLARE_WRITE_UNCONFIRMED" : "CLOUDFLARE_RESPONSE_INVALID", "api", write); }
        if (!response.ok || payload.success !== true || payload.errors?.length) throw new ReleaseFailure(`CLOUDFLARE_HTTP_${response.status}`, "api", write);
        return payload.result;
    };
}

export function verifySupportBindings(profile, settings) {
    const bindings = new Map((settings.bindings ?? []).map((binding) => [binding.name, binding]));
    const expected = {
        DB: ["d1", "id", profile.d1DatabaseId], STATE: ["kv_namespace", "namespace_id", profile.stateId],
        PRIVATE_MEDIA: ["r2_bucket", "bucket_name", profile.privateBucket], PUBLIC_MEDIA: ["r2_bucket", "bucket_name", profile.publicBucket],
        QUOTA: ["durable_object_namespace", "namespace_id", profile.profile.support.doNamespaceId], AUTH_RATE_LIMIT: ["ratelimit", "namespace_id", profile.rateLimitNamespaceId],
    };
    for (const [name, [type, key, value]] of Object.entries(expected)) {
        const binding = bindings.get(name);
        if (binding?.type !== type || String(binding[key]) !== String(value)) throw new Error("SUPPORT_BINDING_MISMATCH");
    }
    const allowed = new Set([...Object.keys(expected), "EMAIL", "BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "ORIGIN", "MEDIA_ORIGIN", "ENVIRONMENT", "DEPLOYMENT_ENV", "RELEASE_SHA", "EMAIL_FROM"]);
    if ([...bindings.keys()].some((name) => !allowed.has(name))) throw new Error("SUPPORT_EXTRA_BINDING_REJECTED");
    for (const name of ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY"]) if (bindings.get(name)?.type !== "secret_text") throw new Error("SUPPORT_RUNTIME_SECRET_MISSING");
    if (bindings.get("ORIGIN")?.text !== profile.origin || bindings.get("MEDIA_ORIGIN")?.text !== profile.mediaOrigin || bindings.get("ENVIRONMENT")?.text !== "production" || bindings.get("EMAIL_FROM")?.text !== profile.profile.emailFrom) throw new Error("SUPPORT_RUNTIME_SECURITY_MISMATCH");
    const sender = bindings.get("EMAIL");
    if (sender?.type !== "send_email" || JSON.stringify(sender.allowed_sender_addresses) !== JSON.stringify([profile.profile.emailFrom])) throw new Error("SUPPORT_EMAIL_BINDING_MISMATCH");
}

export function verifyPagesBindings(profile, config) {
    if (config.d1_databases?.DB?.id !== profile.d1DatabaseId || config.kv_namespaces?.STATE?.namespace_id !== profile.stateId
        || config.r2_buckets?.PRIVATE_MEDIA?.name !== profile.privateBucket || config.r2_buckets?.PUBLIC_MEDIA?.name !== profile.publicBucket
        || config.services?.AUTH?.service !== profile.supportWorker || config.durable_object_namespaces?.QUOTA?.namespace_id !== profile.profile.support.doNamespaceId) throw new Error("PAGES_BINDING_MISMATCH");
    for (const [kind, names] of Object.entries({ d1_databases: ["DB"], kv_namespaces: ["STATE"], r2_buckets: ["PRIVATE_MEDIA", "PUBLIC_MEDIA"], services: ["AUTH"], durable_object_namespaces: ["QUOTA"] })) {
        if (Object.keys(config[kind] ?? {}).some((name) => !names.includes(name))) throw new Error("PAGES_EXTRA_BINDING_REJECTED");
    }
    if (config.env_vars?.ENVIRONMENT?.value !== "production" || config.env_vars?.DEPLOYMENT_ENV?.value !== profile.environment
        || config.env_vars?.ORIGIN?.value !== profile.origin || config.env_vars?.MEDIA_ORIGIN?.value !== profile.mediaOrigin
        || config.env_vars?.TURNSTILE_SITE_KEY?.value !== profile.turnstileSiteKey || config.env_vars?.PAGES_PROJECT_NAME?.value !== profile.pagesProject) throw new Error("PAGES_RUNTIME_SECURITY_MISMATCH");
    const allowed = new Set(["ENVIRONMENT", "DEPLOYMENT_ENV", "RELEASE_SHA", "ORIGIN", "MEDIA_ORIGIN", "PAGES_PROJECT_NAME", "SKIP_DEPENDENCY_INSTALL", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "CF_ZONE_ID"]);
    if (Object.keys(config.env_vars ?? {}).some((name) => !allowed.has(name))) throw new Error("PAGES_EXTRA_VARIABLE_REJECTED");
}

export function createReleaseIO(profile, variables = process.env, overrides = {}) {
    let deadline = Date.now() + releaseLimits.overallMs;
    const remaining = (maximum = releaseLimits.requestMs) => {
        const time = Math.min(maximum, deadline - Date.now());
        if (time <= 0) throw new ReleaseFailure("RELEASE_DEADLINE", "adapter", true);
        return time;
    };
    const api = overrides.api ?? createCloudflareClient(variables.CLOUDFLARE_API_TOKEN, overrides.fetch ?? fetch, remaining);
    const transport = overrides.fetch ?? fetch;
    const accountBase = `/accounts/${profile.accountId}`;
    const pagesBase = `${accountBase}/pages/projects/${profile.pagesProject}`;
    const supportBase = `${accountBase}/workers/scripts/${profile.supportWorker}`;
    const d1 = async (id, queries, write = false) => {
        const result = await api(`${accountBase}/d1/database/${id}/query`, { method: "POST", body: { batch: queries }, write });
        if (!Array.isArray(result) || result.length !== queries.length || result.some((entry) => entry.success !== true)) throw new Error("RELEASE_D1_RESULT_INVALID");
        return result;
    };
    const query = async (id, sql, params = [], write = false) => (await d1(id, [{ sql, params }], write))[0];
    const control = (sql, params = [], write = false) => query(profile.releaseDatabaseId, sql, params, write);
    const readLease = async () => (await control("SELECT * FROM release_leases WHERE environment = ?", [profile.environment])).results?.[0];
    const supportState = async () => {
        const [settings, deployment] = await Promise.all([api(`${supportBase}/settings`), api(`${supportBase}/deployments`)]);
        const current = deployment.deployments?.[0];
        const versions = current?.versions ?? [];
        if (versions.length !== 1 || versions[0].percentage !== 100) throw new Error("SUPPORT_DEPLOYMENT_NOT_EXCLUSIVE");
        const get = (name) => settings.bindings?.find((binding) => binding.name === name)?.text;
        return { versionId: versions[0].version_id, sha: get("RELEASE_SHA"), environment: get("DEPLOYMENT_ENV"), settings };
    };
    let configurations;
    const io = {
        now: Date.now,
        setDeadline: (value) => { deadline = value; },
        sleep: (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, remaining(milliseconds))),
        log: (value) => console.log(JSON.stringify(value)),
        async headSha(branch) {
            const result = child("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { timeout: remaining(15000) });
            const value = result.split(/\s+/)[0];
            if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("REMOTE_HEAD_UNAVAILABLE");
            return value;
        },
        async acquireLease(leaseId, sha, expiresAt) {
            const result = await control("UPDATE release_leases SET lease_id=?,release_sha=?,phase='lock',expires_at=?,pages_deployment_id=NULL,outcome='running',updated_at=? WHERE environment=? AND lease_id IS NULL", [leaseId, sha, expiresAt, Date.now(), profile.environment], true);
            return result.meta?.changes === 1;
        },
        async assertLease(leaseId, sha) {
            const lease = await readLease();
            return lease?.lease_id === leaseId && lease.release_sha === sha && lease.outcome === "running" && lease.expires_at > Date.now();
        },
        async mark(leaseId, { stage, sha, expiresAt, pagesDeploymentId }) {
            const result = await control("UPDATE release_leases SET phase=?,expires_at=?,pages_deployment_id=?,updated_at=? WHERE environment=? AND lease_id=? AND release_sha=? AND outcome='running'", [stage, expiresAt, pagesDeploymentId ?? null, Date.now(), profile.environment, leaseId, sha], true);
            if (result.meta?.changes !== 1) throw new Error("RELEASE_LEASE_LOST");
        },
        async completeLease(leaseId, sha, pagesId) {
            const result = await control("UPDATE release_leases SET lease_id=NULL,phase='complete',expires_at=NULL,pages_deployment_id=?,outcome='success',updated_at=? WHERE environment=? AND lease_id=? AND release_sha=? AND outcome='running'", [pagesId, Date.now(), profile.environment, leaseId, sha], true);
            if (result.meta?.changes !== 1) throw new Error("RELEASE_LEASE_LOST");
        },
        async failLease(leaseId, { stage, uncertain, pagesDeploymentId }) {
            await control("UPDATE release_leases SET lease_id=CASE WHEN ?=1 THEN lease_id ELSE NULL END,phase=?,pages_deployment_id=?,outcome=?,updated_at=? WHERE environment=? AND lease_id=?", [uncertain ? 1 : 0, stage, pagesDeploymentId ?? null, uncertain ? "blocked_uncertain" : "failed", Date.now(), profile.environment, leaseId], true);
        },
        async verifyRemoteConfiguration() {
            const project = await api(pagesBase);
            const source = project.source?.config;
            if (project.id !== profile.pagesProjectId || project.name !== profile.pagesProject || project.production_branch !== profile.branch || project.source?.type !== "github") throw new Error("PAGES_PROJECT_IDENTITY_MISMATCH");
            if (source?.owner?.toLowerCase() !== "vrclearn" || source?.repo_name?.toLowerCase() !== "vrclearn-store") throw new Error("PAGES_REPOSITORY_IDENTITY_MISMATCH");
            if (source?.production_deployments_enabled !== false || source?.preview_deployment_setting !== "none") throw new Error("PAGES_UNCOORDINATED_DEPLOYMENTS_ENABLED");
            for (const name of ["production", "preview"]) if (project.deployment_configs?.[name]?.fail_open !== false) throw new Error("PAGES_FAIL_OPEN_REJECTED");
            if (project.deployment_configs?.production?.env_vars?.TURNSTILE_SECRET_KEY?.type !== "secret_text") throw new Error("PAGES_RUNTIME_SECRET_MISSING");
            if (!variables.CF_ACCESS_CLIENT_ID || !variables.CF_ACCESS_CLIENT_SECRET) throw new Error("RELEASE_SMOKE_CREDENTIALS_MISSING");
            if (profile.releaseDatabaseId === profile.d1DatabaseId) throw new Error("RELEASE_CONTROL_IS_BUSINESS_DATABASE");
        },
        async runChecks(sha) {
            configurations = await generateDeployment(profile.environment, { releaseSha: sha, branch: profile.branch, projectName: profile.pagesProject });
            const npm = process.platform === "win32" ? "npm.cmd" : "npm";
            const invoke = (args) => {
                const result = spawnSync(npm, args, { cwd: repositoryRoot, env: { ...process.env, DEPLOYMENT_ENV: profile.environment }, shell: process.platform === "win32", encoding: "utf8", timeout: remaining(180000), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
                if (result.error || result.status !== 0) throw new Error("RELEASE_CHECK_FAILED");
            };
            invoke(["test"]); invoke(["run", "build"]); invoke(["run", "preflight"]);
        },
        async localMigrations() {
            return Promise.all((await readdir(resolve(repositoryRoot, "migrations"))).filter((name) => name.endsWith(".sql")).map(async (name) => ({ name, sql: await readFile(resolve(repositoryRoot, "migrations", name), "utf8") })));
        },
        async appliedMigrations() { return (await query(profile.d1DatabaseId, "SELECT name FROM d1_migrations ORDER BY id")).results.map((row) => row.name); },
        async migrationChecksums() {
            return Object.fromEntries((await control("SELECT name,digest FROM release_migration_checksums WHERE environment=?", [profile.environment])).results.map((row) => [row.name, row.digest]));
        },
        async applyMigration(migration) {
            // D1's batch executes the schema and ledger update atomically.
            await d1(profile.d1DatabaseId, [...migration.statements.map((sql) => ({ sql, params: [] })), { sql: "INSERT INTO d1_migrations(name) VALUES(?)", params: [migration.name] }], true);
        },
        async recordMigration(migration) {
            await control("INSERT INTO release_migration_checksums(environment,name,digest) VALUES(?,?,?)", [profile.environment, migration.name, migration.digest], true);
        },
        async deploySupport(sha) {
            if (!configurations?.supportConfigPath || !existsSync(configurations.supportConfigPath)) throw new Error("SUPPORT_CONFIG_NOT_GENERATED");
            child(process.execPath, [resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", configurations.supportConfigPath, "--strict"], { timeout: remaining(120000), env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: profile.accountId, WRANGLER_SEND_METRICS: "false" } });
            const state = await supportState();
            verifySupportBindings(profile, state.settings);
            if (state.environment !== profile.environment || state.sha !== sha) throw new Error("SUPPORT_RELEASE_IDENTITY_MISMATCH");
            return state;
        },
        async setPagesRelease(sha) {
            // A partial env_vars PATCH updates these public metadata keys only;
            // never round-trip secret entries returned by the read API.
            const before = await api(pagesBase);
            const secrets = Object.entries(before.deployment_configs?.production?.env_vars ?? {}).filter(([, entry]) => entry.type === "secret_text").map(([name]) => name);
            await api(pagesBase, { method: "PATCH", body: { deployment_configs: { production: { env_vars: {
                RELEASE_SHA: { type: "plain_text", value: sha }, DEPLOYMENT_ENV: { type: "plain_text", value: profile.environment }, PAGES_PROJECT_NAME: { type: "plain_text", value: profile.pagesProject },
            } } } } });
            const after = await api(pagesBase);
            if (secrets.some((name) => after.deployment_configs?.production?.env_vars?.[name]?.type !== "secret_text")) throw new Error("PAGES_SECRET_RETENTION_UNCONFIRMED");
        },
        async startPages(branch, sha) {
            const form = new FormData(); form.set("branch", branch); form.set("commit_hash", sha); form.set("commit_dirty", "false");
            return api(`${pagesBase}/deployments`, { method: "POST", body: form });
        },
        async pagesDeployment(id) {
            const result = await api(`${pagesBase}/deployments/${encodeURIComponent(id)}`);
            return { sha: result.deployment_trigger?.metadata?.commit_hash, branch: result.deployment_trigger?.metadata?.branch, status: result.latest_stage?.status, skipped: result.is_skipped === true };
        },
        async verifyPublished({ sha, workerVersionId, pagesDeploymentId }) {
            const [worker, project] = await Promise.all([supportState(), api(pagesBase)]);
            if (worker.sha !== sha || worker.versionId !== workerVersionId || worker.environment !== profile.environment) throw new Error("SUPPORT_POST_DEPLOY_MISMATCH");
            verifySupportBindings(profile, worker.settings);
            verifyPagesBindings(profile, project.deployment_configs.production);
            const canonical = project.canonical_deployment;
            if (canonical?.id !== pagesDeploymentId || canonical.deployment_trigger?.metadata?.commit_hash !== sha) throw new Error("PAGES_CANONICAL_MISMATCH");
            await io.verifyRemoteConfiguration();
        },
        async smoke({ sha, pagesDeploymentId }) {
            const deployment = await api(`${pagesBase}/deployments/${encodeURIComponent(pagesDeploymentId)}`);
            const preview = new URL(deployment.url);
            if (preview.protocol !== "https:" || !preview.hostname.endsWith(`.${profile.pagesProject}.pages.dev`)) throw new Error("PAGES_PREVIEW_ORIGIN_MISMATCH");
            const anonymous = [profile.origin + "/en", profile.origin + "/api/v1/config", profile.mediaOrigin + "/intl/release-probe", `https://${profile.pagesProject}.pages.dev/en`, preview.origin + "/en"];
            for (const url of anonymous) {
                const response = await transport(url, { redirect: "manual", signal: AbortSignal.timeout(remaining()) });
                const location = response.headers.get("location");
                if (response.status !== 302 || !location || !new URL(location).hostname.endsWith(".cloudflareaccess.com")) throw new Error("ACCESS_SMOKE_FAILED");
            }
            const response = await transport(profile.origin + "/api/v1/config", { redirect: "manual", signal: AbortSignal.timeout(remaining()), headers: { "CF-Access-Client-Id": variables.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": variables.CF_ACCESS_CLIENT_SECRET } });
            if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("APPLICATION_SMOKE_FAILED");
            const config = await response.json();
            if (config.releaseSha !== sha || config.deploymentEnvironment !== profile.environment) throw new Error("APPLICATION_RELEASE_MISMATCH");
        },
    };
    return { ...io, ...overrides };
}
