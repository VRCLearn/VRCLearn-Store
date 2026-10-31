import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("optional Noto font delivery", () => {
    it("keeps every Google CDN subset optional, isolated from installed families and within the supported weight range", () => {
        const css = readFileSync("src/fonts.css", "utf8");
        const faces = Array.from(css.matchAll(/@font-face\s*\{([^}]+)\}/g), (match) => match[1]);
        expect(faces.length).toBeGreaterThan(3);
        expect(new Set(faces.map((face) => /font-family:\s*'([^']+)'/.exec(face)?.[1]))).toEqual(new Set(["VRCLearn Noto Sans", "VRCLearn Noto Sans SC", "VRCLearn Noto Sans JP"]));
        for (const face of faces) {
            expect(face).toContain("font-display: optional;");
            expect(face).toContain("font-weight: 400 700;");
            expect(face).toContain("unicode-range:");
            expect(face).not.toContain("local(");
            const source = new URL(/src:\s*url\(([^)]+)\)/.exec(face)![1]);
            expect(source.protocol).toBe("https:");
            expect(source.hostname).toBe("fonts.gstatic.com");
            expect(source.pathname).toMatch(/\.woff2$/);
        }
        expect(readFileSync("index.html", "utf8")).not.toContain("fonts.googleapis.com");
    });
});
