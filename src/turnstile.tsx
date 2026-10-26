import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { MessageKey } from "./i18n";

interface TurnstileApi {
    render(container: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void; theme: string }): string;
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
        script.onload = () => resolve();
        script.onerror = () => { scriptPromise = undefined; reject(new Error("Verification unavailable")); };
        document.head.append(script);
    });
    return scriptPromise;
}

export function Verification({ onToken, t, action = "auth" }: { onToken: (token: string) => void; t: Record<MessageKey, string>; action?: string }) {
    const container = useRef<HTMLDivElement>(null);
    const callback = useRef(onToken);
    const [error, setError] = useState("");
    callback.current = onToken;
    useEffect(() => {
        let cancelled = false;
        let widget: string | undefined;
        setError("");
        async function start() {
            try {
                const config = await api<{ turnstileSiteKey: string }>("/config");
                if (!config.turnstileSiteKey) throw new Error(t.turnstileMissing);
                await loadScript();
                if (cancelled || !container.current || !window.turnstile) return;
                widget = window.turnstile.render(container.current, {
                    sitekey: config.turnstileSiteKey,
                    action,
                    callback: (token) => callback.current(token),
                    "expired-callback": () => callback.current(""),
                    "error-callback": () => { callback.current(""); setError(t.actionUnavailable); },
                    theme: "auto",
                });
            } catch { if (!cancelled) setError(t.turnstileMissing); }
        }
        void start();
        return () => { cancelled = true; if (widget && window.turnstile) window.turnstile.remove(widget); callback.current(""); };
    }, [t, action]);
    return <div className="verification"><div ref={container} />{error && <p role="alert" className="error-text">{error}</p>}</div>;
}
