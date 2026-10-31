import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const families = ["noto-sans", "noto-sans-sc", "noto-sans-jp"];

describe("self-hosted Noto font delivery", () => {
    it("uses the provider's subset declarations and preloads only the normal Latin file used by that CSS", () => {
        const css = readFileSync("src/fonts.css", "utf8");
        expect(css).not.toMatch(/https?:|@font-face/);
        const imports = Array.from(css.matchAll(/@import "([^"]+)";/g), (match) => match[1]);
        expect(imports).toEqual([
            "@fontsource-variable/noto-sans/wght.css", "@fontsource-variable/noto-sans/wght-italic.css",
            "@fontsource-variable/noto-sans-sc/wght.css", "@fontsource-variable/noto-sans-jp/wght.css",
        ]);
        const html = readFileSync("index.html", "utf8");
        const preloads = html.match(/<link[^>]+rel="preload"[^>]+as="font"[^>]*>/g) ?? [];
        expect(preloads).toHaveLength(1);
        expect(preloads[0]).toContain('type="font/woff2" crossorigin');
        const href = /href="([^"]+)"/.exec(preloads[0]!)![1];
        expect(href).toBe("/node_modules/@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2");
        expect(readFileSync(href.slice(1)).subarray(0, 4).toString()).toBe("wOF2");
        expect(readFileSync("node_modules/@fontsource-variable/noto-sans/wght.css", "utf8")).toContain("./files/noto-sans-latin-wght-normal.woff2");
        expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    });

    it("ships the installed Noto fonts' own copyright and complete OFL notices", () => {
        const notices = readFileSync("public/font-licenses.txt", "utf8");
        for (const family of families) {
            const path = `node_modules/@fontsource-variable/${family}`;
            const metadata = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
            expect(metadata.license).toBe("OFL-1.1");
            expect(notices).toContain(`${metadata.name}@${metadata.version}`);
            const license = readFileSync(`${path}/LICENSE`, "utf8").split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trim();
            expect(notices).toContain(license);
        }
        expect(notices).toContain("AGPL-3.0-only license does not replace them");
    });
});
