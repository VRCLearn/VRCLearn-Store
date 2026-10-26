import {
    argbFromHex,
    Hct,
    hexFromArgb,
    MaterialDynamicColors,
    SchemeContent,
    SchemeExpressive,
    SchemeFidelity,
    SchemeFruitSalad,
    SchemeMonochrome,
    SchemeNeutral,
    SchemeRainbow,
    SchemeTonalSpot,
    SchemeVibrant,
    type DynamicScheme
} from "@material/material-color-utilities";

export const THEME_STORAGE_KEY = "store-appearance";
export const THEME_SCHEMES = ["tonal-spot", "fidelity", "monochrome", "neutral", "vibrant", "expressive", "content", "rainbow", "fruit-salad"] as const;
export type ThemeScheme = typeof THEME_SCHEMES[number];
export type ThemeMode = "system" | "light" | "dark";
export interface ThemePreferences {
    source: string;
    scheme: ThemeScheme;
    mode: ThemeMode;
}
export interface HctValues {
    hue: number;
    chroma: number;
    tone: number;
}
export const DEFAULT_THEME: Readonly<ThemePreferences> = Object.freeze({ source: "#6cb6ff", scheme: "vibrant", mode: "system" });

export function normalizeHex(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const hex = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
    if (/^#[0-9a-f]{3}$/.test(hex)) return "#" + [...hex.slice(1)].map((character) => character + character).join("");
    return null;
}

export function isThemeScheme(value: unknown): value is ThemeScheme {
    return typeof value === "string" && THEME_SCHEMES.some((scheme) => scheme === value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
    return value === "system" || value === "light" || value === "dark";
}

export function parseThemePreferences(value: string | null): ThemePreferences {
    if (!value) return { ...DEFAULT_THEME };
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_THEME };
        const source = "source" in parsed ? normalizeHex(parsed.source) : null;
        const scheme = "scheme" in parsed ? parsed.scheme : undefined;
        const mode = "mode" in parsed ? parsed.mode : undefined;
        if (!source || !isThemeScheme(scheme) || !isThemeMode(mode) || Object.keys(parsed).some((key) => !["source", "scheme", "mode"].includes(key))) return { ...DEFAULT_THEME };
        return { source, scheme, mode };
    } catch {
        return { ...DEFAULT_THEME };
    }
}

export function sourceHct(source: string): HctValues {
    const hct = Hct.fromInt(argbFromHex(normalizeHex(source) ?? DEFAULT_THEME.source));
    return { hue: Math.round(hct.hue), chroma: Math.round(hct.chroma), tone: Math.round(hct.tone) };
}

function clamp(value: number, maximum: number): number {
    return Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0;
}

export function sourceFromHct(values: HctValues): string {
    return hexFromArgb(Hct.from(clamp(values.hue, 360), clamp(values.chroma, 150), clamp(values.tone, 100)).toInt());
}

function createScheme(source: Hct, dark: boolean, name: ThemeScheme): DynamicScheme {
    switch (name) {
        case "content": return new SchemeContent(source, dark, 0);
        case "expressive": return new SchemeExpressive(source, dark, 0);
        case "fidelity": return new SchemeFidelity(source, dark, 0);
        case "fruit-salad": return new SchemeFruitSalad(source, dark, 0);
        case "monochrome": return new SchemeMonochrome(source, dark, 0);
        case "neutral": return new SchemeNeutral(source, dark, 0);
        case "rainbow": return new SchemeRainbow(source, dark, 0);
        case "tonal-spot": return new SchemeTonalSpot(source, dark, 0);
        case "vibrant": return new SchemeVibrant(source, dark, 0);
    }
}

export function themeTokens(preferences: ThemePreferences, dark: boolean): Record<string, string> {
    const scheme = createScheme(Hct.fromInt(argbFromHex(normalizeHex(preferences.source) ?? DEFAULT_THEME.source)), dark, preferences.scheme);
    const colors = new MaterialDynamicColors();
    // allColors omits several standard roles, including surfaceTint. Use the
    // public accessors so every component receives the complete Material theme.
    const roles = {
        primary: colors.primary(),
        "surface-tint": colors.surfaceTint(),
        "on-primary": colors.onPrimary(),
        "primary-container": colors.primaryContainer(),
        "on-primary-container": colors.onPrimaryContainer(),
        secondary: colors.secondary(),
        "on-secondary": colors.onSecondary(),
        "secondary-container": colors.secondaryContainer(),
        "on-secondary-container": colors.onSecondaryContainer(),
        tertiary: colors.tertiary(),
        "on-tertiary": colors.onTertiary(),
        "tertiary-container": colors.tertiaryContainer(),
        "on-tertiary-container": colors.onTertiaryContainer(),
        error: colors.error(),
        "on-error": colors.onError(),
        "error-container": colors.errorContainer(),
        "on-error-container": colors.onErrorContainer(),
        background: colors.background(),
        "on-background": colors.onBackground(),
        surface: colors.surface(),
        "on-surface": colors.onSurface(),
        "surface-variant": colors.surfaceVariant(),
        "on-surface-variant": colors.onSurfaceVariant(),
        outline: colors.outline(),
        "outline-variant": colors.outlineVariant(),
        shadow: colors.shadow(),
        scrim: colors.scrim(),
        "inverse-surface": colors.inverseSurface(),
        "inverse-on-surface": colors.inverseOnSurface(),
        "inverse-primary": colors.inversePrimary(),
        "primary-fixed": colors.primaryFixed(),
        "on-primary-fixed": colors.onPrimaryFixed(),
        "primary-fixed-dim": colors.primaryFixedDim(),
        "on-primary-fixed-variant": colors.onPrimaryFixedVariant(),
        "secondary-fixed": colors.secondaryFixed(),
        "on-secondary-fixed": colors.onSecondaryFixed(),
        "secondary-fixed-dim": colors.secondaryFixedDim(),
        "on-secondary-fixed-variant": colors.onSecondaryFixedVariant(),
        "tertiary-fixed": colors.tertiaryFixed(),
        "on-tertiary-fixed": colors.onTertiaryFixed(),
        "tertiary-fixed-dim": colors.tertiaryFixedDim(),
        "on-tertiary-fixed-variant": colors.onTertiaryFixedVariant(),
        "surface-dim": colors.surfaceDim(),
        "surface-bright": colors.surfaceBright(),
        "surface-container-lowest": colors.surfaceContainerLowest(),
        "surface-container-low": colors.surfaceContainerLow(),
        "surface-container": colors.surfaceContainer(),
        "surface-container-high": colors.surfaceContainerHigh(),
        "surface-container-highest": colors.surfaceContainerHighest(),
    };
    const tokens: Record<string, string> = {};
    for (const [role, color] of Object.entries(roles)) {
        tokens[`--md-sys-color-${role}`] = hexFromArgb(color.getArgb(scheme));
    }
    return tokens;
}
