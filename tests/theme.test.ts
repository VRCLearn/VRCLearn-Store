import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, normalizeHex, parseThemePreferences, sourceFromHct, sourceHct, THEME_SCHEMES, themeTokens } from "../src/theme/core";

describe("configurable Material color themes", () => {
    it("rejects malformed local settings and normalizes valid colors", () => {
        expect(normalizeHex(" #ABC ")).toBe("#aabbcc");
        expect(normalizeHex("red; background:url(https://example.com)")).toBeNull();
        expect(parseThemePreferences('{"source":"#000000","scheme":"unknown","mode":"dark"}')).toEqual(DEFAULT_THEME);
        expect(parseThemePreferences("[]")).toEqual(DEFAULT_THEME);
        expect(parseThemePreferences("not JSON")).toEqual(DEFAULT_THEME);
        expect(parseThemePreferences(JSON.stringify({ source: "#ABC", scheme: "vibrant", mode: "dark" }))).toEqual({ source: "#aabbcc", scheme: "vibrant", mode: "dark" });
    });
    it("generates complete semantic roles for all nine color styles in both modes", () => {
        const roles = [
            "primary", "surface-tint", "on-primary", "primary-container", "on-primary-container",
            "secondary", "on-secondary", "secondary-container", "on-secondary-container",
            "tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container",
            "error", "on-error", "error-container", "on-error-container", "background", "on-background",
            "surface", "on-surface", "surface-variant", "on-surface-variant", "outline", "outline-variant",
            "shadow", "scrim", "inverse-surface", "inverse-on-surface", "inverse-primary",
            "primary-fixed", "on-primary-fixed", "primary-fixed-dim", "on-primary-fixed-variant",
            "secondary-fixed", "on-secondary-fixed", "secondary-fixed-dim", "on-secondary-fixed-variant",
            "tertiary-fixed", "on-tertiary-fixed", "tertiary-fixed-dim", "on-tertiary-fixed-variant",
            "surface-dim", "surface-bright", "surface-container-lowest", "surface-container-low",
            "surface-container", "surface-container-high", "surface-container-highest"
        ];
        for (const scheme of THEME_SCHEMES) {
            for (const dark of [false, true]) {
                const tokens = themeTokens({ ...DEFAULT_THEME, scheme }, dark);
                for (const role of roles) expect(tokens[`--md-sys-color-${role}`], `${scheme} / ${role}`).toMatch(/^#[a-f0-9]{6}$/);
                expect(Object.keys(tokens)).toHaveLength(49);
            }
        }
    });
    it("matches the VRCLearn website default palette and supplies component surface roles", () => {
        expect(DEFAULT_THEME).toEqual({ source: "#6cb6ff", scheme: "vibrant", mode: "system" });
        for (const [dark, expected] of [
            [false, { primary: "#0062a0", surface: "#f8f9ff", "surface-variant": "#dae3f1" }],
            [true, { primary: "#9bcaff", surface: "#0d141c", "surface-variant": "#3f4753" }],
        ] as const) {
            const tokens = themeTokens(DEFAULT_THEME, dark);
            for (const [role, color] of Object.entries(expected)) expect(tokens[`--md-sys-color-${role}`]).toBe(color);
            expect(tokens["--md-sys-color-surface-tint"]).toBe(expected.primary);
            expect(tokens["--md-sys-color-shadow"]).toBe("#000000");
            expect(tokens["--md-sys-color-scrim"]).toBe("#000000");
        }
    });
    it("changes the entire palette with the source, scheme and display mode", () => {
        const base = themeTokens({ ...DEFAULT_THEME }, false);
        const green = themeTokens({ ...DEFAULT_THEME, source: "#00aa44" }, false);
        const neutral = themeTokens({ ...DEFAULT_THEME, scheme: "monochrome" }, false);
        const dark = themeTokens({ ...DEFAULT_THEME }, true);
        expect(green["--md-sys-color-primary"]).not.toBe(base["--md-sys-color-primary"]);
        expect(neutral["--md-sys-color-primary"]).not.toBe(base["--md-sys-color-primary"]);
        expect(dark["--md-sys-color-surface"]).not.toBe(base["--md-sys-color-surface"]);
    });
    it("keeps out-of-range or non-finite HCT input inside the valid color space", () => {
        const extreme = sourceFromHct({ hue: 999, chroma: -20, tone: 999 });
        expect(extreme).toMatch(/^#[a-f0-9]{6}$/);
        const values = sourceHct(extreme);
        expect(values.hue).toBeGreaterThanOrEqual(0);
        expect(values.hue).toBeLessThanOrEqual(360);
        expect(values.tone).toBe(100);
        expect(sourceFromHct({ hue: NaN, chroma: Infinity, tone: NaN })).toBe("#000000");
    });
});
