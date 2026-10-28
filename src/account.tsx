import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import type { SessionUser } from "../shared/contracts";
import { Card, Field, Tabs, LinkButton, Icon } from "./material";
import { ApiError } from "./api";
import { Verification } from "./turnstile";
import { ActionButton, Busy, currentUser, Form, Notice, useAction, useLocale } from "./ui";

const auth = createAuthClient();
type AuthResult<T> = { data: T | null; error: { message?: string; code?: string; status: number; requestId?: string } | null };
export function checked<T>(result: AuthResult<T>): T {
    if (result.error) throw new ApiError(result.error.message ?? "Authentication failed", result.error.status, result.error.code ?? "AUTH_FAILED", result.error.requestId);
    if (!result.data) throw new ApiError("Authentication returned no result", 503, "SERVICE_UNAVAILABLE");
    return result.data;
}

export function AccountPage() {
    const { t, path } = useLocale();
    const [user, setUser] = useState<SessionUser | null>();
    const [mode, setMode] = useState<"login" | "register">("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [token, setToken] = useState("");
    const [verificationKey, setVerificationKey] = useState(0);
    const action = useAction();
    useEffect(() => { void action.run(async () => setUser(await currentUser())); }, []);
    function changeMode(next: typeof mode) { setMode(next); action.clear(); setToken(""); setVerificationKey((key) => key + 1); }
    async function loginOrRegister() {
        await action.run(async () => {
            if (!token) throw new Error(t.turnstileWait);
            const fetchOptions = { headers: { "x-turnstile-token": token } };
            try {
                if (mode === "register") {
                    checked(await auth.signUp.email({ name: displayName, email, password, fetchOptions }));
                } else {
                    checked(await auth.signIn.email({ email, password, fetchOptions }));
                }
                setUser(await currentUser()); setPassword("");
            } finally { setToken(""); setVerificationKey((key) => key + 1); }
        });
    }
    async function changePassword() {
        await action.run(async () => {
            if (newPassword !== confirmPassword) throw new Error(t.passwordMismatch);
            checked(await auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }));
            setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
            action.setMessage(t.passwordChanged);
        });
    }
    return <>
        <div className="page-heading"><p className="eyebrow">VRCLearn Store</p><h1>{t.account}</h1><p>{t.accountIntro}</p></div>
        <Notice error={action.error} message={action.message} />
        {user === undefined && action.busy ? <Busy /> : user ? <Card className="auth-panel panel">
            <div className="shop-avatar" aria-hidden="true">{user.name.slice(0, 1)}</div>
            <h2>{user.name}</h2><p>{user.email}</p>
            <div className="account-links">
                <LinkButton variant="tonal" icon="favorite" href={path("/favorites")}>{t.favorites}</LinkButton>
                <LinkButton variant="tonal" icon="storefront" href={path("/merchant")}>{t.merchant}</LinkButton>
                {user.role === "admin" && <LinkButton variant="tonal" icon="shield" href={path("/admin")}>{t.admin}</LinkButton>}
            </div>
            <details className="account-session-actions"><summary>{t.changePassword}</summary>
                <Form onSubmit={changePassword}>
                    <Field label={t.currentPassword} type="password" value={currentPassword} onChange={setCurrentPassword} required minLength={12} maxLength={128} autoComplete="current-password" />
                    <Field label={t.newPassword} type="password" value={newPassword} onChange={setNewPassword} required minLength={12} maxLength={128} autoComplete="new-password" />
                    <Field label={t.confirmPassword} type="password" value={confirmPassword} onChange={setConfirmPassword} required minLength={12} maxLength={128} autoComplete="new-password" />
                    <ActionButton busy={action.busy} type="submit">{t.changePassword}</ActionButton>
                </Form>
            </details>
            <details className="account-session-actions"><summary>{t.sessionSettings}</summary><div className="button-row">
                <ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { checked(await auth.revokeOtherSessions()); action.setMessage(t.success); }); }}>{t.revokeSessions}</ActionButton>
            </div></details>
            <ActionButton busy={action.busy} variant="text" onClick={() => { void action.run(async () => { checked(await auth.signOut()); setUser(null); }); }}>{t.logout}</ActionButton>
        </Card> : <Card className="auth-panel panel">
            <Tabs tabs={[{ value: "login", label: t.login }, { value: "register", label: t.register }]} value={mode} onChange={(value) => changeMode(value === "register" ? "register" : "login")} />
            <div className="auth-heading"><Icon name="account_circle" size={32} /><h2>{mode === "register" ? t.register : t.login}</h2><p>{mode === "register" ? t.accountRegisterHint : t.accountLoginHint}</p></div>
            <Form onSubmit={loginOrRegister}>
                {mode === "register" && <Field label={t.displayName} value={displayName} onChange={setDisplayName} required maxLength={100} autoComplete="nickname" />}
                <Field label={t.email} type="email" value={email} onChange={setEmail} required maxLength={254} autoComplete="email" />
                <Field label={t.password} type="password" value={password} onChange={setPassword} required minLength={12} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} />
                <Verification key={verificationKey} onToken={setToken} t={t} />
                <ActionButton busy={action.busy} type="submit" disabled={!token}>{mode === "register" ? t.register : t.login}</ActionButton>
            </Form>
        </Card>}
    </>;
}
