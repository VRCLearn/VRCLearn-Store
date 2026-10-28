import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDeployment, repositoryRoot } from "./environment.mjs";

const mediaPlaceholder = "__STORE_MEDIA_ORIGIN__";

function normalizedOrigin(value) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Static media policy requires a normalized HTTP origin");
    return url;
}

export async function staticBuildContext(variables = process.env, { manifestPath, localConfigPath = resolve(repositoryRoot, "deployment/local-pages.jsonc") } = {}) {
    const environment = variables.DEPLOYMENT_ENV || "local";
    const nativePages = variables.CF_PAGES === "1";
    const workersBuild = Boolean(variables.WORKERS_CI_BRANCH);
    if (environment === "local") {
        if (nativePages || workersBuild) throw new Error("Cloud builds require an explicit production or test identity");
        const config = JSON.parse(await readFile(localConfigPath, "utf8"));
        if (config.vars?.DEPLOYMENT_ENV !== "local" || config.vars?.ENVIRONMENT !== "development") throw new Error("Local media policy requires the local Pages configuration");
        const media = normalizedOrigin(config.vars.MEDIA_ORIGIN);
        if (!["localhost", "127.0.0.1", "[::1]"].includes(media.hostname)) throw new Error("Local media policy cannot allow a cloud media origin");
        return { environment, mediaOrigin: media.origin };
    }
    const deployment = await loadDeployment(environment, { manifestPath });
    if (nativePages && (variables.CF_PAGES_BRANCH !== deployment.branch || variables.PAGES_PROJECT_NAME !== deployment.pagesProject)) throw new Error("Static Pages policy does not match the fixed project and branch");
    if (workersBuild && (variables.WORKERS_CI_BRANCH !== deployment.branch || variables.PAGES_PROJECT_NAME !== deployment.pagesProject)) throw new Error("Static build policy does not match the fixed project and branch");
    return { environment, mediaOrigin: deployment.mediaOrigin };
}

export function buildStaticHeaders(template, mediaOrigin) {
    normalizedOrigin(mediaOrigin);
    if (template.split(mediaPlaceholder).length !== 2) throw new Error("Static headers must contain exactly one media origin placeholder");
    return template.replace(mediaPlaceholder, mediaOrigin);
}

export function validateStaticHeaders(template, headers, mediaOrigin) {
    try { return headers === buildStaticHeaders(template, mediaOrigin) ? [] : ["Static headers do not match the selected environment media origin"]; }
    catch { return ["Static media header template or origin is invalid"]; }
}
