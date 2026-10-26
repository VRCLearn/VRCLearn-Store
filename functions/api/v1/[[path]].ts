import { handleApi } from "../../../server/api";
import type { AppEnv } from "../../../server/env";
import { allowedHost, secureResponse } from "../../../edge/respond";

export const onRequest: PagesFunction<AppEnv> = async (context) => {
    if (!allowedHost(context.request, context.env)) return secureResponse(new Response("Not found", { status: 404 }));
    return secureResponse(await handleApi(context.request, context.env, context));
};
