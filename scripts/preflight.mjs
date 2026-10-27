import { readFile } from "node:fs/promises";

const pages = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const support = JSON.parse(await readFile(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8"));
const policies = JSON.parse(await readFile(new URL("../deployment/edge-policies.json", import.meta.url), "utf8"));
const errors = [];
const realId = (value) => typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value) && !/^[0-]+$/.test(value);
const edgeId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
for (const [name, config] of [["Pages", pages], ["Support", support]]) {
    if (!realId(config.d1_databases?.[0]?.database_id)) errors.push(`${name}: configure a dedicated D1 database ID`);
    if (!realId(config.kv_namespaces?.[0]?.id)) errors.push(`${name}: configure a dedicated KV namespace ID`);
}
if (pages.d1_databases[0].database_id !== support.d1_databases[0].database_id) errors.push("Pages and Support must use the same D1 database");
if (pages.kv_namespaces[0].id !== support.kv_namespaces[0].id) errors.push("Pages and Support must use the same STATE namespace");
if (!pages.vars.TURNSTILE_SITE_KEY) errors.push("Configure the production Turnstile site key");
if (pages.vars.ORIGIN !== support.vars.ORIGIN) errors.push("Runtime origins differ");
if (pages.vars.MEDIA_ORIGIN !== support.vars.MEDIA_ORIGIN) errors.push("Runtime media origins differ");
if (support.workers_dev !== false || support.preview_urls !== false || support.routes?.length) errors.push("Support Worker must remain service-binding-only");
if (!edgeId(support.vars.CF_ACCOUNT_ID) || !edgeId(support.vars.CF_ZONE_ID)) errors.push("Configure the monitored account and emergency zone IDs");
if (!edgeId(support.vars.EDGE_RULESET_ID) || !edgeId(support.vars.EDGE_RULE_ID) || !edgeId(support.vars.EDGE_MEDIA_RULE_ID)
    || support.vars.EDGE_RULE_ID === support.vars.EDGE_MEDIA_RULE_ID) errors.push("Configure distinct pre-created dynamic and media emergency edge rule IDs");
if (!support.vars.ALERT_EMAIL) errors.push("Configure an operations alert mailbox");
if (policies.mediaAccess?.action !== "block" || policies.mediaAccess?.enabled !== true) errors.push("Media-region enforcement policy is missing");
for (const name of ["emergencyDynamicStop", "emergencyMediaStop"]) {
    if (policies[name]?.action !== "block" || policies[name]?.enabled !== false) errors.push(`Pre-create a disabled ${name} policy`);
}
if (errors.length) {
    console.error("Production configuration is incomplete:\n" + errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
} else {
    console.log("Configuration references are consistent. This does not verify remote rules, secrets, billing access, or authorize deployment.");
}
