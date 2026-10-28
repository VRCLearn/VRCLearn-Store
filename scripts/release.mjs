import { pathToFileURL } from "node:url";
import { loadDeployment } from "./environment.mjs";
import { runRelease, ReleaseFailure } from "./release-core.mjs";
import { createReleaseIO, gitIdentity } from "./release-cloudflare.mjs";

export async function main(variables = process.env, args = process.argv.slice(2)) {
    if (args.length > 2 || (args.length && (args[0] !== "--environment" || !args[1]))) throw new Error("Use --environment production or --environment test");
    const environment = args[1] ?? variables.DEPLOYMENT_ENV;
    if (environment !== variables.DEPLOYMENT_ENV) throw new Error("Platform deployment environment mismatch");
    const profile = await loadDeployment(environment);
    return runRelease(profile, gitIdentity(variables), createReleaseIO(profile, variables));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { await main(); }
    catch (error) {
        // Child output, API payloads and environment values may contain secrets.
        console.error(JSON.stringify({ event: "release_aborted", code: error instanceof ReleaseFailure ? error.code : "RELEASE_SETUP_FAILED" }));
        process.exitCode = 1;
    }
}
