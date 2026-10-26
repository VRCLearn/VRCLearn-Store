import { writeFile } from "node:fs/promises";
import { createServer } from "vite";

// Vite resolves the official color library with the same module rules as the app.
const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    ssr: { noExternal: ["@material/material-color-utilities"] }
});
try {
    const { DEFAULT_THEME, themeTokens } = await server.ssrLoadModule("/src/theme/core.ts");
    const declarations = (dark) => Object.entries(themeTokens(DEFAULT_THEME, dark)).map(([key, value]) => `    ${key}: ${value};`).join("\n");
    const css = `/* Generated from Material Color Utilities. Edit DEFAULT_THEME in core.ts, then npm run generate:theme. */\n:root {\n${declarations(false)}\n}\n@media (prefers-color-scheme: dark) {\n    :root {\n${declarations(true).split("\n").map((line) => `    ${line}`).join("\n")}\n    }\n}\n`;
    await writeFile(new URL("../src/theme/default.css", import.meta.url), css);
} finally {
    await server.close();
}
