import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { MessageKey } from "./i18n";
import { Button, Spinner } from "./material";

interface TurnstileApi {
    render(container: HTMLElement, options: {
        sitekey: string;
        action: string;
        callback: (token: string) => void;
        "expired-callback": () => void;
        "error-callback": (code: string) => boolean;
        "timeout-callback": () => void;
        theme: "auto";
        retry: "never";
        "refresh-expired": "manual";
        "refresh-timeout": "manual";
    }): string;
    remove(id: string): void;
}
declare global {
    interface Window { turnstile?: TurnstileApi; }
}

let scriptPromise: Promise<void> | undefined;
function loadScript() {
    if (window.turnstile) return Promise.resolve();
    scriptPromise ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        const fail = () => {
            window.clearTimeout(timeout);
            script.remove();
            scriptPromise = undefined;
            reject(new Error("Verification unavailable"));
        };
        const timeout = window.setTimeout(fail, 15_000);
        script.onload = () => {
            if (!window.turnstile) { fail(); return; }
            window.clearTimeout(timeout);
            scriptPromise = undefined;
            resolve();
        };
        script.onerror = fail;
        document.head.append(script);
    });
    return scriptPromise;
}

export function Verification({ onToken, t, action = "auth" }: { onToken: (token: string) => void; t: Record<MessageKey, string>; action?: string }) {
    const container = useRef<HTMLDivElement>(null);
    const callback = useRef(onToken);
    const [failure, setFailure] = useState<"load" | "challenge" | "expired" | "timeout">();
    const [waiting, setWaiting] = useState(true);
    const [attempt, setAttempt] = useState(0);
    callback.current = onToken;
    useEffect(() => {
        let cancelled = false;
        let active = true;
        let hasToken = false;
        let widget: string | undefined;
        let widgetApi: TurnstileApi | undefined;
        let watchdog: number | undefined;
        const controller = new AbortController();
        const configTimeout = window.setTimeout(() => controller.abort(), 15_000);
        setFailure(undefined);
        setWaiting(true);
        callback.current("");
        function clearWatchdog() {
            window.clearTimeout(watchdog);
            watchdog = undefined;
        }
        function removeWidget() {
            if (widget === undefined) return;
            const id = widget;
            widget = undefined;
            widgetApi?.remove(id);
        }
        function fail(reason: NonNullable<typeof failure>) {
            if (cancelled || !active) return;
            active = false;
            clearWatchdog();
            callback.current("");
            setWaiting(false);
            setFailure(reason);
            removeWidget();
        }
        async function start() {
            try {
                const config = await api<{ turnstileSiteKey: string }>("/config", { signal: controller.signal }).finally(() => window.clearTimeout(configTimeout));
                if (cancelled) return;
                if (!config.turnstileSiteKey) throw new Error("Verification unavailable");
                await loadScript();
                if (cancelled || !container.current) return;
                widgetApi = window.turnstile;
                if (!widgetApi) throw new Error("Verification unavailable");
                widget = widgetApi.render(container.current, {
                    sitekey: config.turnstileSiteKey,
                    action,
                    callback: (token) => {
                        if (cancelled || !active) return;
                        if (!token) { fail("challenge"); return; }
                        hasToken = true;
                        clearWatchdog();
                        setWaiting(false);
                        setFailure(undefined);
                        callback.current(token);
                    },
                    "expired-callback": () => fail("expired"),
                    "error-callback": () => { fail("challenge"); return true; },
                    "timeout-callback": () => fail("timeout"),
                    theme: "auto",
                    retry: "never",
                    "refresh-expired": "manual",
                    "refresh-timeout": "manual",
                });
                // A provider callback can run synchronously inside render(). Keep
                // terminal attempts removed and never time out a token already issued.
                if (cancelled || !active) { removeWidget(); return; }
                if (!hasToken) watchdog = window.setTimeout(() => fail("timeout"), 120_000);
            } catch { fail("load"); }
        }
        void start();
        return () => { cancelled = true; active = false; clearWatchdog(); window.clearTimeout(configTimeout); controller.abort(); callback.current(""); removeWidget(); };
    }, [t, action, attempt]);
    const error = failure === "load" ? t.turnstileMissing : failure === "challenge" ? t.turnstileFailed : failure === "expired" ? t.turnstileExpired : failure === "timeout" ? t.turnstileTimeout : "";
    return <div className="verification"><div ref={container} />{waiting && <div className="busy"><Spinner label={t.turnstilePending} /><span>{t.turnstilePending}</span></div>}{error && <><p role="alert" className="error-text">{error}</p><Button variant="outlined" icon="refresh" onClick={() => { setFailure(undefined); setWaiting(true); setAttempt((current) => current + 1); }}>{t.retryVerification}</Button></>}</div>;
}
