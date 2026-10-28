import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore Native Node release scripts are tested directly.
import { runRelease, validateReleaseIdentity } from "../scripts/release-core.mjs";
import { deploymentContext, releaseSha as sha } from "./deployment-fixture";

const profile = deploymentContext();
const identity = { branch: "test", sha, platformSha: sha, workerName: profile.appWorker, dirty: false };
function fixture() {
    let time = 0;
    const stages: string[] = [];
    const io = {
        now: () => time, sleep: async (ms: number) => { time += ms; }, log: vi.fn(), headSha: vi.fn(async () => sha), acquireLease: vi.fn(async () => true), assertLease: vi.fn(async () => true),
        mark: vi.fn(async (_id: string, { stage }: { stage: string }) => { stages.push(stage); }), completeLease: vi.fn(async () => {}), failLease: vi.fn(async () => {}), verifyResourceIdentities: vi.fn(async () => {}), verifyRemoteConfiguration: vi.fn(async () => {}), runChecks: vi.fn(async () => {}),
        localMigrations: async () => [{ name: "0001_initial.sql", sql: readFileSync("migrations/0001_initial.sql", "utf8") }], appliedMigrations: async () => ["0001_initial.sql"], migrationChecksums: async () => ({}), applyMigration: vi.fn(async () => {}), recordMigration: vi.fn(async () => {}),
        deploySupport: vi.fn(async () => ({ versionId: "support-version", sha })), deployApp: vi.fn(async () => ({ versionId: "app-version", sha })), verifyPublished: vi.fn(async () => {}), smoke: vi.fn(async () => {}),
    };
    return { io, stages };
}
const limits = { overallMs: 1000, lockWaitMs: 50, lockAttempts: 3 };
describe("single-checkout coordinated Worker releases", () => {
    it("builds once, publishes support then app and verifies both before releasing the lease", async () => {
        const { io, stages } = fixture();
        expect(await runRelease(profile, identity, io, limits)).toMatchObject({ sha, appVersionId: "app-version", supportVersionId: "support-version" });
        expect(stages).toEqual(["checks", "migrations", "support", "app", "verify", "smoke"]);
        expect(io.runChecks).toHaveBeenCalledOnce();
        expect(io.deploySupport.mock.invocationCallOrder[0]).toBeLessThan(io.deployApp.mock.invocationCallOrder[0]);
        expect(io.completeLease).toHaveBeenCalledOnce(); expect(io.failLease).not.toHaveBeenCalled();
    });
    it("rejects production before any read or write operation", async () => {
        const { io } = fixture();
        await expect(runRelease({ ...profile, environment: "production" }, identity, io)).rejects.toThrow("DEPLOYMENT_DISABLED");
        expect(io.verifyResourceIdentities).not.toHaveBeenCalled(); expect(io.acquireLease).not.toHaveBeenCalled();
    });
    it.each([{ branch: "main" }, { platformSha: "b".repeat(40) }, { dirty: true }, { workerName: "vrclearn-store" }, { sha: "short" }])("rejects a wrong source/target identity %j", (change) => { expect(() => validateReleaseIdentity(profile, { ...identity, ...change })).toThrow(); });
    it("bounds contention and never steals an uncertain lease", async () => {
        const { io } = fixture(); io.acquireLease.mockResolvedValue(false);
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("RELEASE_BUSY");
        expect(io.acquireLease).toHaveBeenCalledTimes(2); expect(io.deploySupport).not.toHaveBeenCalled();
    });
    it("stops a superseded checkout before any deployment", async () => {
        const { io } = fixture(); io.headSha.mockResolvedValueOnce(sha).mockResolvedValue("b".repeat(40));
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("SUPERSEDED");
        expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: false })); expect(io.deploySupport).not.toHaveBeenCalled();
    });
    it.each(["deploySupport", "deployApp"] as const)("does not replay an upload with an unknown outcome: %s", async (operation) => {
        const { io } = fixture(); io[operation].mockRejectedValue(new Error("private response with credentials"));
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("RELEASE_OPERATION_FAILED");
        expect(io[operation]).toHaveBeenCalledOnce(); expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true }));
        expect(JSON.stringify(io.log.mock.calls)).not.toContain("private response"); expect(io.completeLease).not.toHaveBeenCalled();
    });
    it("does not publish a main Worker after a support version mismatch", async () => {
        const { io } = fixture(); io.deploySupport.mockResolvedValue({ versionId: "wrong", sha: "b".repeat(40) });
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("SUPPORT_VERSION_MISMATCH"); expect(io.deployApp).not.toHaveBeenCalled();
    });
    it("keeps the lease when smoke or final version verification fails", async () => {
        const { io } = fixture(); io.verifyPublished.mockRejectedValue(new Error("WORKER_POST_DEPLOY_MISMATCH"));
        await expect(runRelease(profile, identity, io, limits)).rejects.toThrow("WORKER_POST_DEPLOY_MISMATCH");
        expect(io.smoke).not.toHaveBeenCalled(); expect(io.failLease).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ uncertain: true, appVersionId: "app-version", supportVersionId: "support-version" }));
    });
});
