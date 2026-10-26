import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { escapeHtml, safeJson, safeMarkdown } from "../edge/html";

describe("static routing and safe detail output", () => {
    const routes = JSON.parse(readFileSync("public/_routes.json", "utf8")) as { include: string[]; exclude: string[] };
    const matches = (path: string) => routes.include.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(path));
    it("keeps shell pages and assets outside Functions", () => {
        for (const path of ["/", "/en", "/zh-CN/search", "/ja/account", "/en/merchant", "/en/admin", "/assets/app.js", "/maintenance.html"]) expect(matches(path), path).toBe(false);
        for (const path of ["/api/v1/products", "/api/auth/sign-in/email", "/en/products/1", "/ja/shops/1", "/sitemap.xml"]) expect(matches(path), path).toBe(true);
    });
    it("does not allow raw HTML, JavaScript links or remote Markdown images", () => {
        const result = safeMarkdown('<script>alert(1)</script>\n\n[click](javascript:alert%281%29)\n\n![x](https://tracker.example/pixel)');
        expect(result).not.toContain("<script>");
        expect(result).not.toContain('href="javascript:');
        expect(result).not.toContain("<img");
    });
    it("escapes HTML attributes and script-data terminators", () => {
        expect(escapeHtml('\"<&')).toBe("&quot;&lt;&amp;");
        expect(safeJson({ text: "</script><script>alert(1)</script>" })).not.toContain("<");
    });
});
