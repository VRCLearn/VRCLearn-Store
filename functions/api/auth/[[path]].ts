import type { AppEnv } from "../../../server/env";
import { allowedHost, secureResponse, unavailable } from "../../../edge/respond";

export const onRequest: PagesFunction<AppEnv> = async ({ request, env }) => {
    if (!allowedHost(request, env)) return secureResponse(new Response("Not found", { status: 404 }));
    try {
        const response = await env.AUTH.fetch(request);
        const secured = secureResponse(response);
        secured.headers.set("Cache-Control", "no-store");
        return secured;
    } catch {
        return secureResponse(unavailable());
    }
};
