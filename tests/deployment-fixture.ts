import { readFileSync } from "node:fs";

export const releaseSha = "a".repeat(40);
export function deploymentFixture() {
    const manifest = JSON.parse(readFileSync("deployment/environments.json", "utf8"));
    let index = 20;
    const id = () => (++index).toString(16).padStart(32, "0");
    const profile = manifest.test;
    profile.provisioned = true;
    for (const key of ["app", "support", "database", "state", "releaseDatabase"]) profile[key].id = id();
    profile.support.doNamespaceId = id();
    profile.support.rateLimitNamespaceId = "2026102901";
    profile.turnstile.siteKey = "0x-test-fixture-only";
    profile.access = { applicationId: id(), policyId: id() };
    profile.edge = { rulesetId: id(), mediaRuleId: id(), cacheRulesetId: id(), cacheRuleId: id() };
    return manifest;
}
export function deploymentContext(manifest = deploymentFixture()) {
    const profile = manifest.test;
    return { environment: "test", accountId: manifest.accountId, zoneId: manifest.zoneId, branch: profile.branch, appWorker: profile.app.name, appWorkerId: profile.app.id, supportWorker: profile.support.name, supportWorkerId: profile.support.id, d1DatabaseId: profile.database.id, stateId: profile.state.id, origin: profile.origin, mediaOrigin: profile.mediaOrigin, privateBucket: profile.privateBucket, publicBucket: profile.publicBucket, rateLimitNamespaceId: profile.support.rateLimitNamespaceId, turnstileSiteKey: profile.turnstile.siteKey, releaseDatabaseId: profile.releaseDatabase.id, profile, manifest };
}

export function workerSettings(profile: ReturnType<typeof deploymentContext>, kind: "app" | "support") {
    const plain = (name: string, text: string) => ({ name, type: "plain_text", text });
    return { limits: { cpu_ms: kind === "app" ? 50 : 500 }, bindings: [
        { name: "DB", type: "d1", id: profile.d1DatabaseId }, { name: "STATE", type: "kv_namespace", namespace_id: profile.stateId },
        { name: "PRIVATE_MEDIA", type: "r2_bucket", bucket_name: profile.privateBucket }, { name: "PUBLIC_MEDIA", type: "r2_bucket", bucket_name: profile.publicBucket },
        { name: "QUOTA", type: "durable_object_namespace", namespace_id: profile.profile.support.doNamespaceId },
        ...(kind === "app" ? [{ name: "AUTH", type: "service", service: profile.supportWorker }, { name: "ASSETS", type: "assets" }, plain("TURNSTILE_SITE_KEY", profile.turnstileSiteKey)] : [{ name: "AUTH_RATE_LIMIT", type: "ratelimit", namespace_id: profile.rateLimitNamespaceId }, { name: "BETTER_AUTH_SECRET", type: "secret_text" }]),
        { name: "TURNSTILE_SECRET_KEY", type: "secret_text" }, plain("ORIGIN", profile.origin), plain("MEDIA_ORIGIN", profile.mediaOrigin), plain("ENVIRONMENT", "production"), plain("DEPLOYMENT_ENV", "test"), plain("RELEASE_SHA", releaseSha),
    ] };
}
