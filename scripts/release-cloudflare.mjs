import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateDeployment, repositoryRoot } from "./environment.mjs";
import { releaseLimits, ReleaseFailure } from "./release-core.mjs";
import { migrationStatements } from "./migration-policy.mjs";
import { validateBuiltApplication, validateBuiltSupport } from "./preflight.mjs";

function child(command, args, { timeout = 180000, env = process.env } = {}) {
    const result = spawnSync(command, args, { cwd: repositoryRoot, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("RELEASE_CHILD_FAILED");
    return result.stdout.trim();
}

export function gitIdentity(variables = process.env) {
    const sha = child("git", ["rev-parse", "HEAD"], { timeout: 10000 });
    return {
        sha, branch: variables.WORKERS_CI_BRANCH, platformSha: variables.WORKERS_CI_COMMIT_SHA,
        workerName: variables.WORKER_NAME,
        dirty: Boolean(child("git", ["status", "--porcelain", "--untracked-files=no"], { timeout: 10000 })),
    };
}

function isSelectRequest(path, body) {
    if (!/^\/accounts\/[^/]+\/d1\/database\/[^/]+\/(query|raw)$/.test(path) || !body || body instanceof FormData) return false;
    const queries = Array.isArray(body.batch) ? body.batch : [body];
    if (!queries.length) return false;
    try {
        return queries.every(({ sql }) => migrationStatements(sql).every(({ tokens }) => tokens[0]?.value === "SELECT"
            && !tokens.some((token) => token.kind === "word" && ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "PRAGMA", "ATTACH", "DETACH", "VACUUM"].includes(token.value))));
    } catch { return false; }
}

export function createCloudflareClient(token, transport = fetch, remainingMs = () => releaseLimits.requestMs, sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))) {
    if (typeof token !== "string" || token.length < 20) throw new Error("RELEASE_TOKEN_MISSING");
    return async function cloudflare(path, { method = "GET", body, write = method !== "GET" } = {}) {
        if (!path.startsWith("/accounts/") || path.includes("..") || path.includes("?token=")) throw new Error("RELEASE_API_PATH_REJECTED");
        const headers = { Authorization: `Bearer ${token}` };
        if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
        const attempts = !write && (method === "GET" || method === "POST" && isSelectRequest(path, body)) ? 3 : 1;
        const budget = (maximum) => {
            const left = remainingMs();
            if (left <= 0) throw new ReleaseFailure("RELEASE_DEADLINE", "api", write);
            return Math.min(maximum, left);
        };
        for (let attempt = 0; attempt < attempts; attempt++) {
            const signal = AbortSignal.timeout(budget(releaseLimits.requestMs));
            let response, failure, raw;
            try {
                response = await transport(`https://api.cloudflare.com/client/v4${path}`, {
                    method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
                    redirect: "error", signal,
                });
            } catch { failure = write ? "CLOUDFLARE_WRITE_UNCONFIRMED" : "CLOUDFLARE_READ_FAILED"; }
            if (!failure && response.status >= 500 && response.status <= 599) failure = `CLOUDFLARE_HTTP_${response.status}`;
            if (!failure && !response.ok) throw new ReleaseFailure(`CLOUDFLARE_HTTP_${response.status}`, "api", write);
            if (!failure) {
                try { raw = await response.text(); }
                catch { failure = write ? "CLOUDFLARE_WRITE_UNCONFIRMED" : "CLOUDFLARE_READ_FAILED"; }
            }
            if (!failure) {
                let payload;
                try { payload = JSON.parse(raw); }
                catch { throw new ReleaseFailure(write ? "CLOUDFLARE_WRITE_UNCONFIRMED" : "CLOUDFLARE_RESPONSE_INVALID", "api", write); }
                if (!payload || payload.success !== true || payload.errors?.length) throw new ReleaseFailure(`CLOUDFLARE_HTTP_${response.status}`, "api", write);
                return payload.result;
            }
            try { await response?.body?.cancel(); } catch { /* Never expose raw transport or response diagnostics. */ }
            if (attempt + 1 === attempts) throw new ReleaseFailure(failure, "api", write);
            await sleep(budget([250, 750][attempt]));
        }
    };
}

const smokeFailureCodes = Object.freeze({
    site: { transport: "SMOKE_SITE_TRANSPORT_FAILED", http: "SMOKE_SITE_HTTP_FAILED", access: "SMOKE_SITE_ACCESS_FAILED" },
    api: { transport: "SMOKE_API_TRANSPORT_FAILED", http: "SMOKE_API_HTTP_FAILED", access: "SMOKE_API_ACCESS_FAILED" },
    media: { transport: "SMOKE_MEDIA_TRANSPORT_FAILED", http: "SMOKE_MEDIA_HTTP_FAILED", access: "SMOKE_MEDIA_ACCESS_FAILED" },
    config: { transport: "SMOKE_CONFIG_TRANSPORT_FAILED", http: "SMOKE_CONFIG_HTTP_FAILED", access: "SMOKE_CONFIG_ACCESS_FAILED" },
});

async function smokeGet(target, url, { transport, remaining, sleep, headers }) {
    const codes = smokeFailureCodes[target];
    for (let attempt = 0; attempt < 3; attempt++) {
        // Each attempt and its backoff share the release's absolute deadline.
        const signal = AbortSignal.timeout(remaining());
        let response, config, failure;
        try { response = await transport(url, { method: "GET", redirect: "manual", signal, ...(headers ? { headers } : {}) }); }
        catch { failure = codes.transport; }
        if (!failure && response.status >= 500 && response.status <= 599) failure = codes.http;
        if (!failure && target === "config" && response.ok && response.headers.get("content-type")?.includes("application/json")) {
            try { config = await response.json(); }
            catch (error) {
                if (error instanceof SyntaxError) throw new Error("SMOKE_CONFIG_RESPONSE_INVALID");
                failure = codes.transport;
            }
        }
        if (!failure) return { response, config };
        try { await response?.body?.cancel(); } catch { /* Discard only; never expose transport diagnostics. */ }
        if (attempt === 2) throw new Error(failure);
        await sleep(remaining([250, 750][attempt]));
    }
}

export function verifyWorkerBindings(profile, settings, kind) {
    const bindings = new Map((settings.bindings ?? []).map((binding) => [binding.name, binding]));
    const expected = {
        DB: ["d1", "id", profile.d1DatabaseId], STATE: ["kv_namespace", "namespace_id", profile.stateId],
        PRIVATE_MEDIA: ["r2_bucket", "bucket_name", profile.privateBucket], PUBLIC_MEDIA: ["r2_bucket", "bucket_name", profile.publicBucket],
        QUOTA: ["durable_object_namespace", "namespace_id", profile.profile.support.doNamespaceId],
        ...(kind === "support" ? { AUTH_RATE_LIMIT: ["ratelimit", "namespace_id", profile.rateLimitNamespaceId] } : { AUTH: ["service", "service", profile.supportWorker], ASSETS: ["assets"] }),
    };
    for (const [name, [type, key, value]] of Object.entries(expected)) {
        const binding = bindings.get(name);
        if (binding?.type !== type || key && String(binding[key]) !== String(value)) throw new Error("WORKER_BINDING_MISMATCH");
    }
    const variables = ["ORIGIN", "MEDIA_ORIGIN", "ENVIRONMENT", "DEPLOYMENT_ENV", "RELEASE_SHA", ...(kind === "app" ? ["TURNSTILE_SITE_KEY"] : [])];
    const secrets = ["TURNSTILE_SECRET_KEY", ...(kind === "support" ? ["BETTER_AUTH_SECRET"] : [])];
    const allowed = new Set([...Object.keys(expected), ...variables, ...secrets]);
    if ([...bindings.keys()].some((name) => !allowed.has(name)) || bindings.size !== (settings.bindings ?? []).length) throw new Error("WORKER_EXTRA_BINDING_REJECTED");
    for (const name of secrets) if (bindings.get(name)?.type !== "secret_text") throw new Error("WORKER_RUNTIME_SECRET_MISSING");
    for (const [name, value] of Object.entries({ ORIGIN: profile.origin, MEDIA_ORIGIN: profile.mediaOrigin, ENVIRONMENT: "production", DEPLOYMENT_ENV: profile.environment, ...(kind === "app" ? { TURNSTILE_SITE_KEY: profile.turnstileSiteKey } : {}) })) if (bindings.get(name)?.type !== "plain_text" || bindings.get(name)?.text !== value) throw new Error("WORKER_RUNTIME_SECURITY_MISMATCH");
    if (settings.limits?.cpu_ms !== (kind === "app" ? 50 : 500)) throw new Error("WORKER_RUNTIME_SECURITY_MISMATCH");
}

export function createReleaseIO(profile, variables = process.env, overrides = {}) {
    let deadline = Date.now() + releaseLimits.overallMs;
    const remaining = (maximum = releaseLimits.requestMs) => { const time = Math.min(maximum, deadline - Date.now()); if (time <= 0) throw new ReleaseFailure("RELEASE_DEADLINE", "adapter", true); return time; };
    const transport = overrides.fetch ?? fetch;
    const sleep = overrides.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, remaining(milliseconds))));
    const api = overrides.api ?? createCloudflareClient(variables.CLOUDFLARE_API_TOKEN, transport, remaining, sleep);
    const executeChild = overrides.executeChild ?? child;
    const readConfiguration = overrides.readConfiguration ?? (async (path) => {
        if (!existsSync(path)) throw new Error("WORKER_CONFIG_NOT_GENERATED");
        return JSON.parse(await readFile(path, "utf8"));
    });
    const accountBase = `/accounts/${profile.accountId}`;
    const workerBase = (kind) => `${accountBase}/workers/scripts/${kind === "app" ? profile.appWorker : profile.supportWorker}`;
    const d1 = async (id, queries, write = false) => {
        const result = await api(`${accountBase}/d1/database/${id}/query`, { method: "POST", body: { batch: queries }, write });
        if (!Array.isArray(result) || result.length !== queries.length || result.some((entry) => entry.success !== true)) throw new Error("RELEASE_D1_RESULT_INVALID");
        return result;
    };
    const query = async (id, sql, params = [], write = false) => (await d1(id, [{ sql, params }], write))[0];
    const control = (sql, params = [], write = false) => query(profile.releaseDatabaseId, sql, params, write);
    const readLease = async () => (await control("SELECT * FROM release_leases WHERE environment = ?", [profile.environment])).results?.[0];
    const workerState = async (kind) => {
        const [settings, deployment] = await Promise.all([api(`${workerBase(kind)}/settings`), api(`${workerBase(kind)}/deployments`)]);
        const versions = deployment.deployments?.[0]?.versions ?? [];
        if (versions.length !== 1 || versions[0].percentage !== 100) throw new Error("WORKER_DEPLOYMENT_NOT_EXCLUSIVE");
        const get = (name) => settings.bindings?.find((binding) => binding.name === name)?.text;
        return { versionId: versions[0].version_id, sha: get("RELEASE_SHA"), environment: get("DEPLOYMENT_ENV"), settings };
    };
    const verifyEndpoints = async (kind) => { const state = await api(`${workerBase(kind)}/subdomain`); if (state.enabled !== false || state.previews_enabled !== false) throw new Error("WORKER_DEFAULT_ENDPOINT_ENABLED"); };
    let configurations;
    const deploy = async (kind, sha) => {
        const path = resolve(repositoryRoot, `dist/${kind}/wrangler.json`);
        const config = await readConfiguration(path);
        if ((kind === "app" ? validateBuiltApplication : validateBuiltSupport)(profile, config, path).length) throw new Error("APP_BUILD_CONFIG_INVALID");
        executeChild(process.execPath, [resolve(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", path, "--strict"], { timeout: remaining(120000), env: {
            ...variables,
            CLOUDFLARE_ACCOUNT_ID: profile.accountId, WRANGLER_SEND_METRICS: "false",
            // A connected Build identifies its entry Worker. Keep Wrangler's
            // checks enabled, but identify each previously verified target here.
            WRANGLER_CI_MATCH_TAG: kind === "app" ? profile.appWorkerId : profile.supportWorkerId,
            WRANGLER_CI_OVERRIDE_NAME: kind === "app" ? profile.appWorker : profile.supportWorker,
        } });
        const state = await workerState(kind);
        verifyWorkerBindings(profile, state.settings, kind); await verifyEndpoints(kind);
        if (state.environment !== profile.environment || state.sha !== sha) throw new Error("WORKER_RELEASE_IDENTITY_MISMATCH");
        return state;
    };
    const io = {
        now: Date.now, setDeadline: (value) => { deadline = value; }, sleep, log: (value) => console.log(JSON.stringify(value)),
        async headSha(branch) { const result = child("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { timeout: remaining(15000) }); const value = result.split(/\s+/)[0]; if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("REMOTE_HEAD_UNAVAILABLE"); return value; },
        async verifyResourceIdentities() {
            for (const expected of [{ id: profile.releaseDatabaseId, name: profile.profile?.releaseDatabase?.name }, { id: profile.d1DatabaseId, name: profile.profile?.database?.name }]) {
                if (!expected.id || !expected.name || profile.releaseDatabaseId === profile.d1DatabaseId) throw new Error("D1_RESOURCE_IDENTITY_MISMATCH");
                const database = await api(`${accountBase}/d1/database/${expected.id}`);
                if (database?.uuid !== expected.id || database?.name !== expected.name) throw new Error("D1_RESOURCE_IDENTITY_MISMATCH");
            }
            for (const [id, name] of [[profile.appWorkerId, profile.appWorker], [profile.supportWorkerId, profile.supportWorker]]) {
                const scripts = await api(`${accountBase}/workers/scripts-search?id=${encodeURIComponent(id)}&per_page=2`);
                if (!Array.isArray(scripts) || scripts.length !== 1 || scripts[0]?.id !== id || scripts[0]?.script_name !== name) throw new Error("WORKER_RESOURCE_IDENTITY_MISMATCH");
            }
            const expectedTitle = profile.profile?.state?.name, seen = new Set();
            if (!profile.stateId || !expectedTitle) throw new Error("KV_RESOURCE_IDENTITY_MISMATCH");
            for (let page = 1; page <= 5; page++) {
                const namespaces = await api(`${accountBase}/storage/kv/namespaces?page=${page}&per_page=100&order=id&direction=asc`);
                if (!Array.isArray(namespaces) || namespaces.length > 100) throw new Error("KV_NAMESPACE_LIST_INVALID");
                for (const namespace of namespaces) {
                    if (typeof namespace?.id !== "string" || !/^[a-f0-9]{32}$/.test(namespace.id) || /^0+$/.test(namespace.id) || typeof namespace.title !== "string" || seen.has(namespace.id)) throw new Error("KV_NAMESPACE_LIST_INVALID");
                    seen.add(namespace.id);
                    if (namespace.id === profile.stateId) { if (namespace.title !== expectedTitle) throw new Error("KV_RESOURCE_IDENTITY_MISMATCH"); return; }
                }
                if (namespaces.length < 100) throw new Error("KV_RESOURCE_IDENTITY_MISMATCH");
            }
            throw new Error("KV_NAMESPACE_LOOKUP_LIMIT");
        },
        async acquireLease(leaseId, sha, expiresAt) { const result = await control("UPDATE release_leases SET lease_id=?,release_sha=?,phase='lock',expires_at=?,app_version_id=NULL,support_version_id=NULL,outcome='running',updated_at=? WHERE environment=? AND lease_id IS NULL", [leaseId, sha, expiresAt, Date.now(), profile.environment], true); return result.meta?.changes === 1; },
        async assertLease(leaseId, sha) { const lease = await readLease(); return lease?.lease_id === leaseId && lease.release_sha === sha && lease.outcome === "running" && lease.expires_at > Date.now(); },
        async mark(leaseId, { stage, sha, expiresAt, appVersionId, supportVersionId }) { const result = await control("UPDATE release_leases SET phase=?,expires_at=?,app_version_id=?,support_version_id=?,updated_at=? WHERE environment=? AND lease_id=? AND release_sha=? AND outcome='running'", [stage, expiresAt, appVersionId ?? null, supportVersionId ?? null, Date.now(), profile.environment, leaseId, sha], true); if (result.meta?.changes !== 1) throw new Error("RELEASE_LEASE_LOST"); },
        async completeLease(leaseId, sha, { appVersionId, supportVersionId }) { const result = await control("UPDATE release_leases SET lease_id=NULL,phase='complete',expires_at=NULL,app_version_id=?,support_version_id=?,outcome='success',updated_at=? WHERE environment=? AND lease_id=? AND release_sha=? AND outcome='running'", [appVersionId, supportVersionId, Date.now(), profile.environment, leaseId, sha], true); if (result.meta?.changes !== 1) throw new Error("RELEASE_LEASE_LOST"); },
        async failLease(leaseId, { stage, uncertain, appVersionId, supportVersionId }) { await control("UPDATE release_leases SET lease_id=CASE WHEN ?=1 THEN lease_id ELSE NULL END,phase=?,app_version_id=?,support_version_id=?,outcome=?,updated_at=? WHERE environment=? AND lease_id=?", [uncertain ? 1 : 0, stage, appVersionId ?? null, supportVersionId ?? null, uncertain ? "blocked_uncertain" : "failed", Date.now(), profile.environment, leaseId], true); },
        async verifyRemoteConfiguration() {
            if (!variables.CF_ACCESS_CLIENT_ID || !variables.CF_ACCESS_CLIENT_SECRET) throw new Error("RELEASE_SMOKE_CREDENTIALS_MISSING");
            if (profile.releaseDatabaseId === profile.d1DatabaseId) throw new Error("RELEASE_CONTROL_IS_BUSINESS_DATABASE");
            for (const kind of ["support", "app"]) { verifyWorkerBindings(profile, await api(`${workerBase(kind)}/settings`), kind); await verifyEndpoints(kind); }
        },
        async runChecks(sha) {
            configurations = await generateDeployment(profile.environment, { releaseSha: sha, branch: profile.branch, workerName: profile.appWorker });
            const npm = process.platform === "win32" ? "npm.cmd" : "npm";
            const env = { ...process.env, DEPLOYMENT_ENV: profile.environment, RELEASE_SHA: sha, WORKER_NAME: profile.appWorker, VRCLEARN_APP_CONFIG: configurations.appConfigPath, VRCLEARN_SUPPORT_CONFIG: configurations.supportConfigPath };
            for (const args of [["test"], ["run", "build"], ["run", "preflight"]]) { const result = spawnSync(npm, args, { cwd: repositoryRoot, env, shell: process.platform === "win32", encoding: "utf8", timeout: remaining(180000), maxBuffer: 4 * 1024 * 1024, windowsHide: true }); if (result.error || result.status !== 0) throw new Error("RELEASE_CHECK_FAILED"); }
        },
        async localMigrations() { return Promise.all((await readdir(resolve(repositoryRoot, "migrations"))).filter((name) => name.endsWith(".sql")).map(async (name) => ({ name, sql: await readFile(resolve(repositoryRoot, "migrations", name), "utf8") }))); },
        async appliedMigrations() {
            const tables = (await query(profile.d1DatabaseId, "SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'")).results.map((row) => row.name);
            const names = tables.includes("d1_migrations") ? (await query(profile.d1DatabaseId, "SELECT name FROM d1_migrations ORDER BY id")).results.map((row) => row.name) : [];
            if (!names.length && tables.some((name) => name !== "d1_migrations")) throw new Error("MIGRATION_DATABASE_NOT_EMPTY");
            return names;
        },
        async migrationChecksums() { return Object.fromEntries((await control("SELECT name,digest FROM release_migration_checksums WHERE environment=?", [profile.environment])).results.map((row) => [row.name, row.digest])); },
        async applyMigration(migration) { const ledger = { sql: "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)", params: [] }; await d1(profile.d1DatabaseId, [...(migration.initial ? [ledger] : []), ...migration.statements.map((sql) => ({ sql, params: [] })), { sql: "INSERT INTO d1_migrations(name) VALUES(?)", params: [migration.name] }], true); },
        async recordMigration(migration) { await control("INSERT INTO release_migration_checksums(environment,name,digest) VALUES(?,?,?)", [profile.environment, migration.name, migration.digest], true); },
        deploySupport: (sha) => deploy("support", sha), deployApp: (sha) => deploy("app", sha),
        async verifyPublished({ sha, appVersionId, supportVersionId }) {
            for (const [kind, versionId] of [["app", appVersionId], ["support", supportVersionId]]) { const state = await workerState(kind); if (state.sha !== sha || state.versionId !== versionId || state.environment !== profile.environment) throw new Error("WORKER_POST_DEPLOY_MISMATCH"); verifyWorkerBindings(profile, state.settings, kind); await verifyEndpoints(kind); }
        },
        async smoke({ sha }) {
            for (const [target, url] of [["site", profile.origin + "/en"], ["api", profile.origin + "/api/v1/config"], ["media", profile.mediaOrigin + "/intl/release-probe"]]) {
                const { response } = await smokeGet(target, url, { transport, remaining, sleep }); try { await response.body?.cancel(); } catch { /* No body is needed. */ }
                if (response.status !== 302) throw new Error(smokeFailureCodes[target].http);
                let valid = false; try { valid = new URL(response.headers.get("location")).hostname.endsWith(".cloudflareaccess.com"); } catch { /* Fail closed. */ }
                if (!valid) throw new Error(smokeFailureCodes[target].access);
            }
            const { response, config } = await smokeGet("config", profile.origin + "/api/v1/config", { transport, remaining, sleep, headers: { "CF-Access-Client-Id": variables.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": variables.CF_ACCESS_CLIENT_SECRET } });
            if ([302, 401, 403].includes(response.status)) throw new Error("SMOKE_CONFIG_ACCESS_FAILED");
            if (!response.ok) throw new Error("SMOKE_CONFIG_HTTP_FAILED");
            if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("SMOKE_CONFIG_RESPONSE_INVALID");
            if (config?.releaseSha !== sha || config?.deploymentEnvironment !== profile.environment) throw new Error("SMOKE_CONFIG_RELEASE_MISMATCH");
        },
    };
    return { ...io, ...overrides };
}
