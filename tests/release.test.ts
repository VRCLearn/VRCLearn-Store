import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node release scripts are tested directly.
import { runRelease, validateReleaseIdentity } from "../scripts/release-core.mjs";
// @ts-ignore Native Node release scripts are tested directly.
import { baselineMigrations } from "../scripts/migration-policy.mjs";
// @ts-ignore Native Node release scripts are tested directly.
import { createCloudflareClient, createReleaseIO, verifyPagesBindings, verifySupportBindings } from "../scripts/release-cloudflare.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const profile = { environment: "test", branch: "test", pagesProject: "test-vrclearn-store" };
const identity = { branch: "test", sha, platformSha: sha, projectName: profile.pagesProject, dirty: false };
const files = Object.keys(baselineMigrations).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") }));
function fixture() {
    let time = 0;
    const calls: string[] = [];
    const io = {
        now: () => time, sleep: async (ms: number) => { time += ms; }, log: vi.fn(), headSha: vi.fn(async () => sha),
        acquireLease: vi.fn(async () => true), assertLease: vi.fn(async () => true), mark: vi.fn(async (_id: string, { stage }: { stage: string }) => { calls.push(stage); }),
        completeLease: vi.fn(async () => {}), failLease: vi.fn(async () => {}), verifyRemoteConfiguration: vi.fn(async () => {}),
        runChecks: vi.fn(async () => {}), localMigrations: async () => files, appliedMigrations: async () => files.map((file) => file.name), migrationChecksums: async () => ({}),
        applyMigration: vi.fn(async () => {}), recordMigration: vi.fn(async () => {}), deploySupport: vi.fn(async () => ({ versionId: "worker-version", sha })),
        setPagesRelease: vi.fn(async () => {}), startPages: vi.fn(async () => ({ id: "pages-deployment" })),
        pagesDeployment: vi.fn(async () => ({ sha, branch: "test", status: "success" })), verifyPublished: vi.fn(async () => {}), smoke: vi.fn(async () => {}),
    };
    return { io, calls };
}
const limits = { overallMs: 1000, lockWaitMs: 50, lockAttempts: 3, pollMs: 10, pollAttempts: 3 };

describe("coordinated automatic release", () => {
    it("publishes Worker before native Git Pages and verifies before releasing its lock", async () => {
        const { io, calls } = fixture();
        expect(await runRelease(profile, identity, io, limits)).toMatchObject({ sha, pagesDeploymentId: "pages-deployment" });
        expect(calls).toEqual(["checks", "migrations", "worker", "pages", "pages_wait", "verify"]);
        expect(io.startPages).toHaveBeenCalledExactlyOnceWith("test", sha);
        expect(io.completeLease).toHaveBeenCalledOnce();
        expect(io.failLease).not.toHaveBeenCalled();
    });
    it.each([
        { branch: "main" }, { platformSha: otherSha }, { dirty: true }, { projectName: "vrclearn-store" }, { sha: "short" },
    ])("rejects source or environment mismatch before any API call %j", async (change) => {
        const { io } = fixture();
        expect(() => validateReleaseIdentity(profile, { ...identity, ...change })).toThrow();
        await expect(runRelease(profile, { ...identity, ...change }, io, limits)).rejects.toThrow();
        expect(io.acquireLease).not.toHaveBeenCalled();
    });
    it("bounds lock contention without taking over an expired or uncertain deployment", async () => {
        const { io } = fixture(); io.acquireLease.mockResolvedValue(false);
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("RELEASE_BUSY");
        expect(io.acquireLease).toHaveBeenCalledTimes(2);
        expect(io.deploySupport).not.toHaveBeenCalled(); expect(io.failLease).not.toHaveBeenCalled();
    });
    it("stops a superseded commit before mutations and releases its own safe lock", async () => {
        const { io } = fixture(); io.headSha.mockResolvedValueOnce(sha).mockResolvedValue(otherSha);
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("SUPERSEDED");
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: false }));
        expect(io.deploySupport).not.toHaveBeenCalled();
    });
    it("keeps a reconciliation lock when Worker upload has an uncertain outcome", async () => {
        const { io } = fixture(); io.deploySupport.mockRejectedValue(new Error("private response must not leak"));
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("RELEASE_OPERATION_FAILED");
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true, stage: "worker" }));
        expect(io.deploySupport).toHaveBeenCalledOnce(); expect(io.startPages).not.toHaveBeenCalled();
        expect(JSON.stringify(io.log.mock.calls)).not.toContain("private response");
    });
    it("does not mistake commit_hash metadata for a Git source pin", async () => {
        const { io } = fixture(); io.pagesDeployment.mockResolvedValue({ sha: otherSha, branch: "test", status: "success" });
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("PAGES_SOURCE_MISMATCH");
        expect(io.completeLease).not.toHaveBeenCalled(); expect(io.smoke).not.toHaveBeenCalled();
    });
    it("bounds Pages waiting and preserves uncertain state instead of blindly re-triggering", async () => {
        const { io } = fixture(); io.pagesDeployment.mockResolvedValue({ sha, branch: "test", status: "active" });
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("PAGES_DEADLINE");
        expect(io.pagesDeployment).toHaveBeenCalledTimes(3); expect(io.startPages).toHaveBeenCalledOnce();
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true, pagesDeploymentId: "pages-deployment" }));
    });
    it("stops when a new commit arrives while the Pages build is pending", async () => {
        const { io } = fixture();
        io.pagesDeployment.mockImplementation(async () => { io.headSha.mockResolvedValue(otherSha); return { sha, branch: "test", status: "active" }; });
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("SUPERSEDED");
        expect(io.startPages).toHaveBeenCalledOnce(); expect(io.completeLease).not.toHaveBeenCalled();
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true }));
    });
    it("fails immediately on a skipped Pages deployment instead of polling or retriggering", async () => {
        const { io } = fixture(); io.pagesDeployment.mockResolvedValue({ sha, branch: "test", status: "skipped" });
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("PAGES_BUILD_SKIPPED");
        expect(io.pagesDeployment).toHaveBeenCalledOnce(); expect(io.startPages).toHaveBeenCalledOnce();
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true }));
    });
    it("rejects a destructive pending migration before support or Pages deployment", async () => {
        const { io } = fixture(); io.localMigrations = async () => [...files, { name: "0005_reset.sql", sql: "DELETE FROM auth_user;" }];
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow();
        expect(io.applyMigration).not.toHaveBeenCalled(); expect(io.deploySupport).not.toHaveBeenCalled();
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: false }));
    });
    it("keeps the lock when a migration succeeded but its cross-database checksum write is unconfirmed", async () => {
        const { io } = fixture(); io.localMigrations = async () => [...files, { name: "0005_widgets.sql", sql: "CREATE TABLE widgets(id TEXT);" }];
        io.recordMigration.mockRejectedValue(new Error("unconfirmed control write"));
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("RELEASE_OPERATION_FAILED");
        expect(io.applyMigration).toHaveBeenCalledOnce(); expect(io.deploySupport).not.toHaveBeenCalled();
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true, stage: "migrations" }));
    });
});

describe("Cloudflare release transport", () => {
    it("never repeats an uncertain write and suppresses response bodies", async () => {
        const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { throw new Error("token value in private transport diagnostic"); });
        const api = createCloudflareClient("local-test-build-token-never-real", fetch);
        await expect(api("/accounts/" + "1".repeat(32) + "/pages/projects/test", { method: "PATCH", body: {} })).rejects.toThrow("WRITE_UNCONFIRMED");
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    });
    it("does not overwrite secret Pages variables while setting public release metadata", async () => {
        const api = vi.fn(async () => ({ deployment_configs: { production: { env_vars: { TURNSTILE_SECRET_KEY: { type: "secret_text" } } } } }));
        const io = createReleaseIO({ ...profile, accountId: "1".repeat(32) }, {}, { api });
        await io.setPagesRelease(sha);
        expect(api).toHaveBeenCalledWith(expect.any(String), { method: "PATCH", body: { deployment_configs: { production: { env_vars: {
            RELEASE_SHA: { type: "plain_text", value: sha }, DEPLOYMENT_ENV: { type: "plain_text", value: "test" }, PAGES_PROJECT_NAME: { type: "plain_text", value: profile.pagesProject },
        } } } } });
        expect(JSON.stringify(api.mock.calls)).not.toContain("TURNSTILE_SECRET_KEY");
    });
    it("stops if the metadata PATCH did not preserve secret bindings", async () => {
        const api = vi.fn().mockResolvedValueOnce({ deployment_configs: { production: { env_vars: { TURNSTILE_SECRET_KEY: { type: "secret_text" } } } } }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
        const io = createReleaseIO({ ...profile, accountId: "1".repeat(32) }, {}, { api });
        await expect(io.setPagesRelease(sha)).rejects.toThrow("SECRET_RETENTION");
        expect(api).toHaveBeenCalledTimes(3);
    });
    it("requests a native Git deployment without a Direct Upload manifest", async () => {
        const api = vi.fn(async () => ({ id: "deployment" }));
        const io = createReleaseIO({ ...profile, accountId: "1".repeat(32) }, {}, { api });
        await io.startPages("test", sha);
        const [, options] = api.mock.calls[0] as unknown as [string, { method: string; body: FormData }];
        expect(options.method).toBe("POST"); expect(options.body.get("branch")).toBe("test");
        expect(options.body.get("commit_hash")).toBe(sha); expect(options.body.has("manifest")).toBe(false);
    });
    it("rejects an unexpected Git repository before migration or deployment", async () => {
        const target = { ...profile, accountId: "1".repeat(32), pagesProjectId: "project-id", releaseDatabaseId: "control", d1DatabaseId: "business" };
        const api = vi.fn(async () => ({ id: target.pagesProjectId, name: target.pagesProject, production_branch: "test", source: { type: "github", config: { owner: "someone-else", repo_name: "VRCLearn-Store" } } }));
        const io = createReleaseIO(target, {}, { api });
        await expect(io.verifyRemoteConfiguration()).rejects.toThrow("REPOSITORY_IDENTITY");
        expect(api).toHaveBeenCalledOnce();
    });
    it("checks the default and unique preview host before authenticated application smoke", async () => {
        const target = { ...profile, accountId: "1".repeat(32), origin: "https://test-store.example.com", mediaOrigin: "https://test-media.example.com" };
        const transport = vi.fn(async (_url: string, options: RequestInit) => options.headers
            ? Response.json({ releaseSha: sha, deploymentEnvironment: "test" })
            : new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } }));
        const api = vi.fn(async () => ({ url: "https://12345678.test-vrclearn-store.pages.dev" }));
        const io = createReleaseIO(target, { CF_ACCESS_CLIENT_ID: "test-only", CF_ACCESS_CLIENT_SECRET: "never-real" }, { api, fetch: transport });
        await io.smoke({ sha, pagesDeploymentId: "deployment" });
        expect(transport).toHaveBeenCalledTimes(6);
        expect(transport).toHaveBeenCalledWith("https://test-vrclearn-store.pages.dev/en", expect.objectContaining({ redirect: "manual" }));
        expect(transport).toHaveBeenCalledWith("https://12345678.test-vrclearn-store.pages.dev/en", expect.objectContaining({ redirect: "manual" }));
        expect(JSON.stringify(api.mock.calls)).not.toContain("never-real");
    });
});

describe("deployed resource isolation", () => {
    const target = {
        ...profile, d1DatabaseId: "test-d1", stateId: "test-kv", privateBucket: "test-private", publicBucket: "test-public", supportWorker: "test-support",
        origin: "https://test-store.example.com", mediaOrigin: "https://test-media.example.com", rateLimitNamespaceId: "1002", turnstileSiteKey: "test-site-key",
        profile: { support: { doNamespaceId: "test-do" }, emailFrom: "test-noreply@example.com" },
    };
    const pages = () => ({
        d1_databases: { DB: { id: target.d1DatabaseId } }, kv_namespaces: { STATE: { namespace_id: target.stateId } },
        r2_buckets: { PRIVATE_MEDIA: { name: target.privateBucket }, PUBLIC_MEDIA: { name: target.publicBucket } },
        services: { AUTH: { service: target.supportWorker } }, durable_object_namespaces: { QUOTA: { namespace_id: target.profile.support.doNamespaceId } },
        env_vars: { ENVIRONMENT: { value: "production" }, DEPLOYMENT_ENV: { value: "test" }, ORIGIN: { value: target.origin }, MEDIA_ORIGIN: { value: target.mediaOrigin }, TURNSTILE_SITE_KEY: { value: target.turnstileSiteKey }, PAGES_PROJECT_NAME: { value: target.pagesProject } },
    });
    const support = () => ({ bindings: [
        { name: "DB", type: "d1", id: target.d1DatabaseId }, { name: "STATE", type: "kv_namespace", namespace_id: target.stateId },
        { name: "PRIVATE_MEDIA", type: "r2_bucket", bucket_name: target.privateBucket }, { name: "PUBLIC_MEDIA", type: "r2_bucket", bucket_name: target.publicBucket },
        { name: "QUOTA", type: "durable_object_namespace", namespace_id: target.profile.support.doNamespaceId }, { name: "AUTH_RATE_LIMIT", type: "ratelimit", namespace_id: target.rateLimitNamespaceId },
        { name: "BETTER_AUTH_SECRET", type: "secret_text" }, { name: "TURNSTILE_SECRET_KEY", type: "secret_text" },
        { name: "ORIGIN", type: "plain_text", text: target.origin }, { name: "MEDIA_ORIGIN", type: "plain_text", text: target.mediaOrigin }, { name: "ENVIRONMENT", type: "plain_text", text: "production" },
        { name: "EMAIL_FROM", type: "plain_text", text: target.profile.emailFrom },
        { name: "EMAIL", type: "send_email", allowed_sender_addresses: [target.profile.emailFrom] },
    ] });
    it("reads back all expected independent business bindings", () => {
        expect(() => verifyPagesBindings(target, pages())).not.toThrow();
        expect(() => verifySupportBindings(target, support())).not.toThrow();
    });
    it("rejects a production resource referenced by the test deployment", () => {
        const config = pages(); config.d1_databases.DB.id = "production-d1";
        expect(() => verifyPagesBindings(target, config)).toThrow("BINDING_MISMATCH");
        const worker = support(); worker.bindings.find((binding) => binding.name === "PUBLIC_MEDIA")!.bucket_name = "production-public";
        expect(() => verifySupportBindings(target, worker)).toThrow("BINDING_MISMATCH");
    });
    it("rejects extra resources or build/control secrets in the business runtime", () => {
        const config = pages(); Object.assign(config.d1_databases, { EXTRA_DATABASE: { id: "production-d1" } });
        expect(() => verifyPagesBindings(target, config)).toThrow("EXTRA_BINDING");
        const worker = support(); worker.bindings.push({ name: "CLOUDFLARE_API_TOKEN", type: "secret_text" });
        expect(() => verifySupportBindings(target, worker)).toThrow("EXTRA_BINDING");
        const secret = pages(); Object.assign(secret.env_vars, { CF_MONITOR_TOKEN: { type: "secret_text" } });
        expect(() => verifyPagesBindings(target, secret)).toThrow("EXTRA_VARIABLE");
    });
});
