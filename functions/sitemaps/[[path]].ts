import { sitemapPage } from "../../edge/ssr";
import type { AppEnv } from "../../server/env";

export const onRequest: PagesFunction<AppEnv> = (context) => sitemapPage(context);
