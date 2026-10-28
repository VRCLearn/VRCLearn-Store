import { createContext, useContext, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { Locale, Product, SessionUser } from "../shared/contracts";
import { api, ApiError, localizedError } from "./api";
import { messages, type MessageKey } from "./i18n";
import { Card, Button, Icon, InteractionState, LinkButton, MaterialSelect, Spinner, type ButtonVariant } from "./material";
import { safeMarkdown } from "../edge/html";

export const LocaleContext = createContext<Locale>("en");
export function useLocale() {
    const locale = useContext(LocaleContext);
    return { locale, t: messages(locale), path: (suffix = "") => `/${locale}${suffix}` };
}

export function Notice({ error, message }: { error?: unknown; message?: string }) {
    const { t } = useLocale();
    if (error) {
        const text = localizedError(error, t);
        return <div className="notice notice-error" role="alert"><Icon name="error" /><div>{text}{error instanceof ApiError && error.requestId && <details className="error-reference"><summary>{t.errorDetails}</summary><code>{error.requestId}</code></details>}</div></div>;
    }
    return message ? <div className="notice notice-success" role="status"><Icon name="check_circle" /><span>{message}</span></div> : null;
}

export function useAction() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>();
    const [message, setMessage] = useState("");
    async function run(action: () => Promise<void>) {
        if (busy) return;
        setBusy(true); setError(undefined); setMessage("");
        try { await action(); } catch (caught) { setError(caught); } finally { setBusy(false); }
    }
    return { busy, error, message, setMessage, run, clear: () => { setError(undefined); setMessage(""); } };
}

export function Form({ children, onSubmit, className = "form-stack" }: { children: ReactNode; onSubmit: () => void | Promise<void>; className?: string }) {
    function submit(event: FormEvent) { event.preventDefault(); void onSubmit(); }
    return <form className={className} onSubmit={submit}>{children}</form>;
}

export function Select({ label, value, onChange, options, required = false, disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; required?: boolean; disabled?: boolean }) {
    return <MaterialSelect label={label} value={value} onChange={onChange} options={options} required={required} disabled={disabled} />;
}

export function Empty({ children }: { children?: ReactNode }) {
    const { t } = useLocale();
    return <div className="empty-state"><Icon name="inventory" size={40} /><p>{children ?? t.empty}</p></div>;
}

export function Markdown({ source }: { source: string }) {
    const html = useMemo(() => safeMarkdown(source), [source]);
    return <div className="product-description" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Busy() {
    const { t } = useLocale();
    return <div className="busy"><Spinner label={t.loading} /><span>{t.loading}</span></div>;
}

export function Price({ product }: { product: Pick<Product, "pricing" | "price" | "currency"> }) {
    const { t, locale } = useLocale();
    if (product.pricing === "free") return <span className="price">{t.free}</span>;
    let display = `${product.currency ?? ""} ${product.price ?? "—"}`;
    if (product.price !== null && product.currency) {
        try { display = new Intl.NumberFormat(locale, { style: "currency", currency: product.currency }).format(product.price); } catch { /* Preserve the original currency without conversion. */ }
    }
    return <span className="price">{display}</span>;
}

export function ProductCard({ product }: { product: Product }) {
    const { t, path } = useLocale();
    return <Card role="article" className="product-card"><Link className="product-image" to={path(`/products/${encodeURIComponent(product.id)}`)}><InteractionState />{product.images[0] ? <img src={product.images[0]} alt="" loading="lazy" width="640" height="480" /> : <span className="image-placeholder" aria-hidden="true"><Icon name={product.category} size={48} /></span>}<span className="category-pill">{t[product.category]}</span></Link><div className="product-card-body"><Link className="seller-link" to={path(`/shops/${encodeURIComponent(product.shopId)}`)}>{product.shopName}</Link><h3><Link to={path(`/products/${encodeURIComponent(product.id)}`)}>{product.title}</Link></h3>{product.r18 && <p>{t.adult}</p>}<p>{product.summary}</p><div className="product-card-bottom"><Price product={product} /><span className="platforms">{product.platforms.map((p) => p === "pc" ? "PC" : "Android").join(" · ")}</span></div></div></Card>;
}

export async function currentUser(): Promise<SessionUser | null> {
    const data = await api<{ user: SessionUser | null }>("/me");
    return data.user;
}

export function SignInPrompt({ admin = false }: { admin?: boolean }) {
    const { t, path } = useLocale();
    return <Card className="panel sign-in-prompt"><Icon name={admin ? "security" : "person"} size={32} /><h2>{admin ? t.adminRequired : t.signInRequired}</h2><LinkButton href={path("/account")} icon="arrow_forward">{t.account}</LinkButton></Card>;
}

export function ActionButton({ busy, children, ...props }: { busy: boolean; children: ReactNode; type?: "button" | "submit"; onClick?: () => void; variant?: ButtonVariant; disabled?: boolean; icon?: string; className?: string }) {
    return <Button {...props} disabled={busy || props.disabled}>{children}</Button>;
}

export function statusLabel(t: Record<MessageKey, string>, status: string) {
    return status in t ? t[status as MessageKey] : status;
}
