import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
// @ts-expect-error build tooling intentionally uses native JavaScript modules
import { staticPageHtml, uiRoutes } from "./scripts/build-static.mjs";

const notoFamilies = new Map([
    ["Noto Sans Variable", "VRCLearn Noto Sans"],
    ["Noto Sans SC Variable", "VRCLearn Noto Sans SC"],
    ["Noto Sans JP Variable", "VRCLearn Noto Sans JP"],
]);

function staticInterfaces(): Plugin {
    return {
        name: "store-static-interfaces",
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                if (!["GET", "HEAD"].includes(request.method ?? "")) return next();
                const url = new URL(request.url ?? "/", "http://127.0.0.1:4173");
                if (url.pathname === "/") {
                    response.writeHead(302, { Location: `/en${url.search}` });
                    response.end();
                    return;
                }
                const pieces = url.pathname.replace(/\/$/, "").split("/").slice(1);
                if (pieces.length > 2 || !uiRoutes.locales.includes(pieces[0]) || !uiRoutes.staticPages.includes(pieces[1] ?? "")) return next();
                try {
                    const source = await readFile(new URL("./index.html", import.meta.url), "utf8");
                    const html = await server.transformIndexHtml(url.pathname, staticPageHtml(source, pieces[0], pieces[1] ?? ""));
                    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    response.end(request.method === "HEAD" ? undefined : html);
                } catch (error) { next(error); }
            });
        },
    };
}

export default defineConfig({
    plugins: [
        react(),
        staticInterfaces(),
        cloudflare({
            configPath: process.env.VRCLEARN_APP_CONFIG ?? "deployment/local-app.jsonc",
            viteEnvironment: { name: "app" },
            auxiliaryWorkers: [{ configPath: process.env.VRCLEARN_SUPPORT_CONFIG ?? "deployment/local-support.jsonc", viteEnvironment: { name: "support" } }],
            remoteBindings: false,
            inspectorPort: false,
        }),
    ],
    css: {
        postcss: {
            plugins: [{
                postcssPlugin: "store-noto-font-policy",
                AtRule: {
                    "font-face"(rule) {
                        let noto = false;
                        rule.walkDecls("font-family", (declaration) => {
                            const alias = notoFamilies.get(declaration.value.replace(/['"]/g, ""));
                            if (!alias) return;
                            declaration.value = `"${alias}"`;
                            noto = true;
                        });
                        if (!noto) return;
                        // Preserve the provider's subsets and files. Site-local
                        // names isolate installed Noto; optional prevents a late swap.
                        rule.walkDecls("font-display", (declaration) => { declaration.value = "optional"; });
                        rule.walkDecls("font-weight", (declaration) => { declaration.value = "400 700"; });
                    },
                },
            }],
        },
    },
    appType: "mpa",
    build: {
        target: "es2022", manifest: true,
        // Even tiny font subsets remain same-origin cacheable files under CSP.
        assetsInlineLimit: (filePath) => /\.woff2$/i.test(filePath) ? false : undefined,
    },
    server: { host: "127.0.0.1", port: 4173, strictPort: true },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
