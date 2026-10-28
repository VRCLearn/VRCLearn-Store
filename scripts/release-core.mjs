import { randomUUID } from "node:crypto";
import { migrationPlan } from "./migration-policy.mjs";

export const releaseLimits = Object.freeze({ overallMs: 720000, lockWaitMs: 120000, lockAttempts: 13, requestMs: 10000 });
const shaPattern = /^[a-f0-9]{40}$/;
const operationFailureCodes = new Set(["RELEASE_CHILD_FAILED", "RELEASE_TOKEN_MISSING", "RELEASE_API_PATH_REJECTED", "RELEASE_D1_RESULT_INVALID", "REMOTE_HEAD_UNAVAILABLE", "RELEASE_LEASE_LOST", "RELEASE_SMOKE_CREDENTIALS_MISSING", "RELEASE_CONTROL_IS_BUSINESS_DATABASE", "RELEASE_CHECK_FAILED", "WORKER_BINDING_MISMATCH", "WORKER_EXTRA_BINDING_REJECTED", "WORKER_RUNTIME_SECRET_MISSING", "WORKER_RUNTIME_SECURITY_MISMATCH", "WORKER_DEPLOYMENT_NOT_EXCLUSIVE", "WORKER_CONFIG_NOT_GENERATED", "WORKER_RELEASE_IDENTITY_MISMATCH", "WORKER_DEFAULT_ENDPOINT_ENABLED", "WORKER_POST_DEPLOY_MISMATCH", "APP_BUILD_CONFIG_INVALID", "SMOKE_SITE_TRANSPORT_FAILED", "SMOKE_SITE_HTTP_FAILED", "SMOKE_SITE_ACCESS_FAILED", "SMOKE_API_TRANSPORT_FAILED", "SMOKE_API_HTTP_FAILED", "SMOKE_API_ACCESS_FAILED", "SMOKE_MEDIA_TRANSPORT_FAILED", "SMOKE_MEDIA_HTTP_FAILED", "SMOKE_MEDIA_ACCESS_FAILED", "SMOKE_CONFIG_TRANSPORT_FAILED", "SMOKE_CONFIG_HTTP_FAILED", "SMOKE_CONFIG_ACCESS_FAILED", "SMOKE_CONFIG_RESPONSE_INVALID", "SMOKE_CONFIG_RELEASE_MISMATCH", "D1_RESOURCE_IDENTITY_MISMATCH", "KV_RESOURCE_IDENTITY_MISMATCH", "KV_NAMESPACE_LIST_INVALID", "KV_NAMESPACE_LOOKUP_LIMIT", "MIGRATION_DATABASE_NOT_EMPTY"]);
export class ReleaseFailure extends Error {
    constructor(code, stage, uncertain = false) { super(code); this.code = code; this.stage = stage; this.uncertain = uncertain; }
}
export function validateReleaseIdentity(profile, identity) {
    if (profile.environment !== "test" || profile.profile?.enabled === false) throw new ReleaseFailure("DEPLOYMENT_DISABLED", "identity");
    if (profile.branch !== "test" || identity.branch !== "test" || identity.workerName !== profile.appWorker) throw new ReleaseFailure("ENVIRONMENT_IDENTITY_MISMATCH", "identity");
    if (!shaPattern.test(identity.sha ?? "") || identity.platformSha !== identity.sha || identity.dirty) throw new ReleaseFailure("SOURCE_IDENTITY_MISMATCH", "identity");
}
export async function runRelease(profile, identity, io, limits = releaseLimits) {
    validateReleaseIdentity(profile, identity);
    const started = io.now(), leaseId = randomUUID();
    io.setDeadline?.(started + limits.overallMs);
    let acquired = false, mutated = false, completed = false, stage = "identity", appVersionId, supportVersionId;
    const checkTime = () => { if (io.now() - started >= limits.overallMs) throw new ReleaseFailure("RELEASE_DEADLINE", stage, mutated); };
    const assertHead = async () => { checkTime(); if (await io.headSha(profile.branch) !== identity.sha) throw new ReleaseFailure("RELEASE_SUPERSEDED", stage, mutated); };
    const assertLease = async () => { checkTime(); if (!await io.assertLease(leaseId, identity.sha)) throw new ReleaseFailure("RELEASE_LEASE_LOST", stage, mutated); };
    const mark = async (next) => {
        stage = next; await assertLease();
        await io.mark(leaseId, { stage, sha: identity.sha, expiresAt: started + limits.overallMs, appVersionId, supportVersionId });
        io.log({ event: "release_stage", environment: profile.environment, sha: identity.sha, stage });
    };
    try {
        stage = "resources"; checkTime(); await io.verifyResourceIdentities(); await assertHead(); stage = "lock";
        for (let attempt = 0; attempt < limits.lockAttempts; attempt++) {
            checkTime(); acquired = await io.acquireLease(leaseId, identity.sha, started + limits.overallMs);
            if (acquired) break;
            if (io.now() - started >= limits.lockWaitMs || attempt + 1 >= limits.lockAttempts) throw new ReleaseFailure("RELEASE_BUSY", stage);
            await io.sleep(Math.min(10000, limits.lockWaitMs - (io.now() - started)));
        }
        if (!acquired) throw new ReleaseFailure("RELEASE_BUSY", stage);
        await assertHead(); await mark("checks"); await io.verifyRemoteConfiguration(); await io.runChecks(identity.sha); await assertHead();
        const planned = migrationPlan(await io.localMigrations(), await io.appliedMigrations(), await io.migrationChecksums());
        await mark("migrations");
        for (const migration of planned) { await assertHead(); await assertLease(); mutated = true; await io.applyMigration(migration); await io.recordMigration(migration); }
        await mark("support"); await assertHead(); mutated = true;
        const support = await io.deploySupport(identity.sha);
        if (!support?.versionId || support.sha !== identity.sha) throw new ReleaseFailure("SUPPORT_VERSION_MISMATCH", stage, true);
        supportVersionId = support.versionId;
        await mark("app"); await assertHead();
        const app = await io.deployApp(identity.sha);
        if (!app?.versionId || app.sha !== identity.sha) throw new ReleaseFailure("APP_VERSION_MISMATCH", stage, true);
        appVersionId = app.versionId;
        await mark("verify"); await io.verifyPublished({ sha: identity.sha, appVersionId, supportVersionId });
        await mark("smoke"); await io.smoke({ sha: identity.sha }); await assertHead(); await assertLease();
        await io.completeLease(leaseId, identity.sha, { appVersionId, supportVersionId }); completed = true;
        io.log({ event: "release_complete", environment: profile.environment, sha: identity.sha, appVersionId, supportVersionId });
        return { environment: profile.environment, sha: identity.sha, appVersionId, supportVersionId };
    } catch (error) {
        const code = error instanceof Error && (operationFailureCodes.has(error.message) || error.message === "WORKER_RESOURCE_IDENTITY_MISMATCH") ? error.message : "RELEASE_OPERATION_FAILED";
        const failure = error instanceof ReleaseFailure ? error : new ReleaseFailure(code, stage, mutated);
        if (acquired && !completed) try { await io.failLease(leaseId, { code: failure.code, stage, uncertain: mutated || failure.uncertain, appVersionId, supportVersionId }); } catch { /* Keep uncertain writes locked until read back. */ }
        io.log({ event: "release_failed", environment: profile.environment, sha: identity.sha, stage, code: failure.code, uncertain: mutated || failure.uncertain });
        throw failure;
    }
}
