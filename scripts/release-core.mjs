import { randomUUID } from "node:crypto";
import { migrationPlan } from "./migration-policy.mjs";

export const releaseLimits = Object.freeze({ overallMs: 720000, lockWaitMs: 120000, lockAttempts: 13, pollMs: 5000, pollAttempts: 120, requestMs: 10000 });
const shaPattern = /^[a-f0-9]{40}$/;

export class ReleaseFailure extends Error {
    constructor(code, stage, uncertain = false) { super(code); this.code = code; this.stage = stage; this.uncertain = uncertain; }
}

export function validateReleaseIdentity(profile, identity) {
    if (!["production", "test"].includes(profile.environment)) throw new ReleaseFailure("UNKNOWN_ENVIRONMENT", "identity");
    const branch = profile.environment === "production" ? "main" : "test";
    if (profile.branch !== branch || identity.branch !== branch || identity.projectName !== profile.pagesProject) throw new ReleaseFailure("ENVIRONMENT_IDENTITY_MISMATCH", "identity");
    if (!shaPattern.test(identity.sha ?? "") || identity.platformSha !== identity.sha || identity.dirty) throw new ReleaseFailure("SOURCE_IDENTITY_MISMATCH", "identity");
}

export async function runRelease(profile, identity, io, limits = releaseLimits) {
    validateReleaseIdentity(profile, identity);
    const started = io.now();
    io.setDeadline?.(started + limits.overallMs);
    const leaseId = randomUUID();
    let acquired = false, mutated = false, completed = false, stage = "identity";
    let pagesDeploymentId;
    const checkTime = () => {
        if (io.now() - started >= limits.overallMs) throw new ReleaseFailure("RELEASE_DEADLINE", stage, mutated);
    };
    const assertHead = async () => {
        checkTime();
        if (await io.headSha(profile.branch) !== identity.sha) throw new ReleaseFailure("RELEASE_SUPERSEDED", stage, mutated);
    };
    const assertLease = async () => {
        checkTime();
        if (!await io.assertLease(leaseId, identity.sha)) throw new ReleaseFailure("RELEASE_LEASE_LOST", stage, mutated);
    };
    const mark = async (next) => {
        stage = next;
        await assertLease();
        await io.mark(leaseId, { stage, sha: identity.sha, expiresAt: started + limits.overallMs, pagesDeploymentId });
        io.log({ event: "release_stage", environment: profile.environment, sha: identity.sha, stage });
    };
    try {
        await assertHead();
        stage = "lock";
        for (let attempt = 0; attempt < limits.lockAttempts; attempt++) {
            checkTime();
            acquired = await io.acquireLease(leaseId, identity.sha, started + limits.overallMs);
            if (acquired) break;
            if (io.now() - started >= limits.lockWaitMs || attempt + 1 >= limits.lockAttempts) throw new ReleaseFailure("RELEASE_BUSY", stage);
            await io.sleep(Math.min(10000, limits.lockWaitMs - (io.now() - started)));
        }
        if (!acquired) throw new ReleaseFailure("RELEASE_BUSY", stage);
        await assertHead();
        await mark("checks");
        await io.verifyRemoteConfiguration();
        await io.runChecks(identity.sha);
        await assertHead();
        const planned = migrationPlan(await io.localMigrations(), await io.appliedMigrations(), await io.migrationChecksums());
        await mark("migrations");
        for (const migration of planned) {
            await assertHead(); await assertLease();
            mutated = true;
            await io.applyMigration(migration);
            await io.recordMigration(migration);
        }
        await mark("worker");
        await assertHead();
        mutated = true;
        const worker = await io.deploySupport(identity.sha);
        await assertLease();
        if (!worker?.versionId || worker.sha !== identity.sha) throw new ReleaseFailure("SUPPORT_VERSION_MISMATCH", stage, true);
        await mark("pages");
        await assertHead();
        await io.setPagesRelease(identity.sha);
        await assertLease();
        // Git branch HEAD is the source. commit_hash is metadata, not a pin.
        const deployment = await io.startPages(profile.branch, identity.sha);
        if (!deployment?.id) throw new ReleaseFailure("PAGES_START_UNCONFIRMED", stage, true);
        pagesDeploymentId = deployment.id;
        await mark("pages_wait");
        let published;
        for (let attempt = 0; attempt < limits.pollAttempts; attempt++) {
            await assertHead();
            await assertLease();
            const state = await io.pagesDeployment(pagesDeploymentId);
            if (state.sha !== identity.sha || state.branch !== profile.branch) throw new ReleaseFailure("PAGES_SOURCE_MISMATCH", stage, true);
            if (state.skipped || state.status === "skipped") throw new ReleaseFailure("PAGES_BUILD_SKIPPED", stage, true);
            if (["failure", "canceled", "cancelled"].includes(state.status)) throw new ReleaseFailure("PAGES_BUILD_FAILED", stage, true);
            if (state.status === "success") { published = state; break; }
            if (attempt + 1 >= limits.pollAttempts) break;
            await io.sleep(limits.pollMs);
        }
        if (!published) throw new ReleaseFailure("PAGES_DEADLINE", stage, true);
        await mark("verify");
        await io.verifyPublished({ sha: identity.sha, workerVersionId: worker.versionId, pagesDeploymentId });
        await assertLease();
        await io.smoke({ sha: identity.sha, pagesDeploymentId });
        await assertHead();
        await assertLease();
        await io.completeLease(leaseId, identity.sha, pagesDeploymentId);
        completed = true;
        io.log({ event: "release_complete", environment: profile.environment, sha: identity.sha, pagesDeploymentId });
        return { environment: profile.environment, sha: identity.sha, pagesDeploymentId, workerVersionId: worker.versionId };
    } catch (error) {
        const failure = error instanceof ReleaseFailure ? error : new ReleaseFailure("RELEASE_OPERATION_FAILED", stage, mutated);
        if (acquired && !completed) {
            // A write may have succeeded despite a timeout. Keep the lease until
            // an operator reads back the Worker, Pages and migration outcomes.
            try { await io.failLease(leaseId, { code: failure.code, stage, uncertain: mutated || failure.uncertain, pagesDeploymentId }); } catch { /* The existing lock must remain closed. */ }
        }
        io.log({ event: "release_failed", environment: profile.environment, sha: identity.sha, stage, code: failure.code, uncertain: mutated || failure.uncertain });
        throw failure;
    }
}
