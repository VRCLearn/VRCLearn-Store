import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_THEME, isThemeMode, isThemeScheme, normalizeHex, parseThemePreferences, sourceFromHct, sourceHct, THEME_STORAGE_KEY, themeTokens, type HctValues, type ThemeMode, type ThemePreferences, type ThemeScheme } from "./core";

interface StoreTheme {
    preferences: ThemePreferences;
    resolvedMode: "light" | "dark";
    sourceHct: HctValues;
    setMode: (mode: ThemeMode) => void;
    setSource: (source: string) => boolean;
    setScheme: (scheme: ThemeScheme) => void;
    setHct: (key: keyof HctValues, value: number) => void;
    reset: () => void;
}
const ThemeContext = createContext<StoreTheme | null>(null);

function savedPreferences(): ThemePreferences {
    try {
        return parseThemePreferences(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
        return { ...DEFAULT_THEME };
    }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [preferences, setPreferences] = useState(savedPreferences);
    const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
    const dark = preferences.mode === "system" ? systemDark : preferences.mode === "dark";
    const tokens = useMemo(() => themeTokens(preferences, dark), [preferences.source, preferences.scheme, dark]);
    const hct = useMemo(() => sourceHct(preferences.source), [preferences.source]);

    useEffect(() => {
        const query = window.matchMedia("(prefers-color-scheme: dark)");
        const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        query.addEventListener("change", changed);
        return () => query.removeEventListener("change", changed);
    }, []);

    useLayoutEffect(() => {
        const root = document.documentElement;
        for (const [name, color] of Object.entries(tokens)) root.style.setProperty(name, color);
        root.dataset.theme = dark ? "dark" : "light";
        root.dataset.themeSource = preferences.source;
        root.dataset.themeScheme = preferences.scheme;
        root.style.colorScheme = dark ? "dark" : "light";
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens["--md-sys-color-surface"]);
    }, [tokens, dark, preferences.source, preferences.scheme]);

    useEffect(() => {
        // Coalesce drag updates so local persistence does not block each slider frame.
        const persist = () => {
            try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preferences)); }
            catch { /* Appearance still works when local storage is unavailable. */ }
        };
        const timer = window.setTimeout(persist, 150);
        window.addEventListener("pagehide", persist);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener("pagehide", persist);
        };
    }, [preferences]);

    const value: StoreTheme = {
        preferences,
        resolvedMode: dark ? "dark" : "light",
        sourceHct: hct,
        setMode: (mode) => { if (isThemeMode(mode)) setPreferences((previous) => ({ ...previous, mode })); },
        setSource: (source) => {
            const normalized = normalizeHex(source);
            if (!normalized) return false;
            setPreferences((previous) => ({ ...previous, source: normalized }));
            return true;
        },
        setScheme: (scheme) => { if (isThemeScheme(scheme)) setPreferences((previous) => ({ ...previous, scheme })); },
        setHct: (key, number) => {
            if (!Number.isFinite(number)) return;
            setPreferences((previous) => ({ ...previous, source: sourceFromHct({ ...sourceHct(previous.source), [key]: number }) }));
        },
        reset: () => setPreferences({ ...DEFAULT_THEME })
    };
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useStoreTheme(): StoreTheme {
    const theme = useContext(ThemeContext);
    if (!theme) throw new Error("ThemeProvider is required");
    return theme;
}
