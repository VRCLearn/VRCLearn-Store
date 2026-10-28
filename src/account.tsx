import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { QRCodeSVG } from "qrcode.react";
import type { SessionUser } from "../shared/contracts";
import { Card, Button, Field, Tabs, LinkButton, Icon } from "./material";
import { ApiError } from "./api";
import { Verification } from "./turnstile";
import { ActionButton, Busy, currentUser, Form, Notice, useAction, useLocale } from "./ui";

const auth = createAuthClient({ plugins: [twoFactorClient()] });
type AuthResult<T> = { data: T | null; error: { message?: string; code?: string; status: number; requestId?: string } | null };
export function checked<T>(result: AuthResult<T>): T {
    if (result.error) throw new ApiError(result.error.message ?? "Authentication failed", result.error.status, result.error.code ?? "AUTH_FAILED", result.error.requestId);
    if (!result.data) throw new ApiError("Authentication returned no result", 503, "SERVICE_UNAVAILABLE");
    return result.data;
}

export function AccountPage() {
    const { t, path } = useLocale();
    const [user, setUser] = useState<SessionUser | null>();
    const [mode, setMode] = useState<"login" | "register" | "forgot" | "totp" | "backup">("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [code, setCode] = useState("");
    const [token, setToken] = useState("");
    const [verificationKey, setVerificationKey] = useState(0);
    const [mfa, setMfa] = useState<{ totpURI: string; backupCodes: string[] }>();
    const action = useAction();
    useEffect(() => { void action.run(async () => setUser(await currentUser())); }, []);
    function changeMode(next: typeof mode) { setMode(next); action.clear(); setToken(""); setVerificationKey((key) => key + 1); setCode(""); }
    async function loginOrRegister() {
        await action.run(async () => {
            if (mode === "totp" || mode === "backup") {
                if (mode === "totp") checked(await auth.twoFactor.verifyTotp({ code, trustDevice: false }));
                else checked(await auth.twoFactor.verifyBackupCode({ code, trustDevice: false }));
                setUser(await currentUser()); setCode(""); setPassword(""); return;
            }
            if (!token) throw new Error(t.turnstileWait);
            const fetchOptions = { headers: { "x-turnstile-token": token } };
            try {
                if (mode === "register") {
                    checked(await auth.signUp.email({ name: displayName, email, password, callbackURL: `${location.origin}${path("/account")}`, fetchOptions }));
                    action.setMessage(t.verificationSent); setPassword("");
                } else if (mode === "forgot") {
                    checked(await auth.requestPasswordReset({ email, redirectTo: `${location.origin}${path("/reset-password")}`, fetchOptions }));
                    action.setMessage(t.resetSent);
                } else {
                    const data = checked(await auth.signIn.email({ email, password, fetchOptions }));
                    if ("twoFactorRedirect" in data && data.twoFactorRedirect) { setMode("totp"); setPassword(""); }
                    else { setUser(await currentUser()); setPassword(""); }
                }
            } finally { setToken(""); setVerificationKey((key) => key + 1); }
        });
    }
    return <><div className="page-heading"><p className="eyebrow">VRCLearn Store</p><h1>{t.account}</h1><p>{t.accountIntro}</p></div><Notice error={action.error} message={action.message} />{user === undefined && action.busy ? <Busy /> : user ? <div className="account-grid"><Card className="panel"><div className="shop-avatar" aria-hidden="true">{user.name.slice(0, 1)}</div><h2>{user.name}</h2><p>{user.email}</p><span className="status-pill">{user.emailVerified ? t.verified : t.unverified}</span><div className="account-links"><LinkButton variant="tonal" icon="favorite" href={path("/favorites")}>{t.favorites}</LinkButton><LinkButton variant="tonal" icon="storefront" href={path("/merchant")}>{t.merchant}</LinkButton>{user.role === "admin" && <LinkButton variant="tonal" icon="shield" href={path("/admin")}>{t.admin}</LinkButton>}</div><details className="account-session-actions"><summary>{t.sessionSettings}</summary><div className="button-row"><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { checked(await auth.revokeOtherSessions()); action.setMessage(t.success); }); }}>{t.revokeSessions}</ActionButton></div></details><ActionButton busy={action.busy} variant="text" onClick={() => { void action.run(async () => { checked(await auth.signOut()); setUser(null); setMfa(undefined); }); }}>{t.logout}</ActionButton></Card><Card className="panel">
        <h2>{t.mfa}</h2>
        {user.role === "admin" && !user.twoFactorVerified && <p className="quiet-note">{t.mfaRequired}</p>}
        {!user.twoFactorEnabled && <>
            <p>{t.mfaIntro}</p>
            <h3>{t.mfaPrepare}</h3>
            <p>{t.mfaAppHint}</p>
        </>}
        {user.twoFactorEnabled ? <>
            <p>{t.mfaEnabled}</p>
            <p>{t.mfaNextLogin}</p>
            {!user.twoFactorVerified && <Form onSubmit={() => action.run(async () => { checked(await auth.twoFactor.verifyTotp({ code, trustDevice: false })); setUser(await currentUser()); setCode(""); action.setMessage(t.success); })}>
                <Field label={t.authenticator} value={code} onChange={setCode} required maxLength={6} supportingText={t.mfaCodeHint} autoComplete="one-time-code" />
                <ActionButton busy={action.busy} type="submit">{t.verify}</ActionButton>
            </Form>}
        </> : mfa ? <>
            <h3>{t.mfaScan}</h3>
            <p>{t.mfaSetup}</p>
            <p>{t.email}: {user.email}</p>
            <QRCodeSVG className="mfa-qr" value={mfa.totpURI} size={256} marginSize={4} level="M" bgColor="#ffffff" fgColor="#000000" title={t.mfaQr} role="img" aria-label={t.mfaQr} />
            <details className="mfa-manual">
                <summary>{t.mfaManual}</summary>
                <p>{t.mfaManualHint}</p>
                <p>{t.mfaSecret}: <code>{new URL(mfa.totpURI).searchParams.get("secret")}</code></p>
                <LinkButton variant="text" href={mfa.totpURI}>{t.mfaOpenApp}</LinkButton>
            </details>
            <h3>{t.mfaConfirm}</h3>
            <p>{t.mfaCodeSource}</p>
            <Form onSubmit={() => action.run(async () => { checked(await auth.twoFactor.verifyTotp({ code, trustDevice: false })); setUser(await currentUser()); setCode(""); action.setMessage(t.mfaEnabled); })}>
                <Field label={t.authenticator} value={code} onChange={setCode} required maxLength={6} supportingText={t.mfaCodeHint} autoComplete="one-time-code" />
                <ActionButton busy={action.busy} type="submit">{t.verify}</ActionButton>
            </Form>
        </> : <>
            <p>{t.mfaPasswordHint}</p>
            <Form onSubmit={() => action.run(async () => { const data = checked(await auth.twoFactor.enable({ password })); if (data.method !== "totp") throw new Error(t.actionUnavailable); setMfa({ totpURI: data.totpURI, backupCodes: data.backupCodes }); setPassword(""); })}>
                <Field label={t.password} type="password" value={password} onChange={setPassword} required autoComplete="current-password" />
                <ActionButton busy={action.busy} type="submit">{t.enableMfa}</ActionButton>
            </Form>
        </>}
        {(mfa || user.twoFactorEnabled) && <details className="mfa-manual">
            <summary>{t.mfaTroubleshoot}</summary>
            <p>{t.mfaTroubleshootHint}</p>
        </details>}
        {mfa && user.twoFactorEnabled && <div className="recovery-codes">
            <h3>{t.recoveryCodes}</h3>
            <p>{t.mfaRecoveryHint}</p>
            <ul>{mfa.backupCodes.map((backup) => <li key={backup}><code>{backup}</code></li>)}</ul>
            <Button variant="outlined" icon="download" onClick={() => {
                const url = URL.createObjectURL(new Blob([`${t.store}\n${user.email}\n\n${mfa.backupCodes.join("\n")}\n`], { type: "text/plain;charset=utf-8" }));
                const link = document.createElement("a");
                link.href = url; link.download = "vrclearn-store-recovery-codes.txt";
                document.body.append(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }}>{t.mfaDownloadCodes}</Button>
        </div>}
    </Card></div> : <Card className="auth-panel panel"><Tabs tabs={[{ value: "login", label: t.login }, { value: "register", label: t.register }]} value={mode === "register" ? "register" : "login"} onChange={(value) => changeMode(value === "register" ? "register" : "login")} /><div className="auth-heading"><Icon name="account_circle" size={32} /><h2>{mode === "register" ? t.register : mode === "forgot" ? t.reset : mode === "totp" ? t.mfa : mode === "backup" ? t.backupCode : t.login}</h2>{(mode === "login" || mode === "register") && <p>{mode === "register" ? t.accountRegisterHint : t.accountLoginHint}</p>}</div><Form onSubmit={loginOrRegister}>{mode === "totp" || mode === "backup" ? <><p>{mode === "totp" ? t.mfaCodeSource : t.mfaBackupHint}</p><Field label={mode === "totp" ? t.authenticator : t.backupCode} value={code} onChange={setCode} required maxLength={mode === "totp" ? 6 : 128} autoComplete="one-time-code" /><ActionButton busy={action.busy} type="submit">{t.verify}</ActionButton><Button variant="text" onClick={() => changeMode(mode === "totp" ? "backup" : "totp")}>{mode === "totp" ? t.backupCode : t.authenticator}</Button></> : <>{mode === "register" && <Field label={t.displayName} value={displayName} onChange={setDisplayName} required maxLength={100} autoComplete="nickname" />}<Field label={t.email} type="email" value={email} onChange={setEmail} required maxLength={254} autoComplete="email" />{mode !== "forgot" && <Field label={t.password} type="password" value={password} onChange={setPassword} required minLength={12} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} />}<Verification key={verificationKey} onToken={setToken} t={t} /><ActionButton busy={action.busy} type="submit" disabled={!token}>{mode === "register" ? t.register : mode === "forgot" ? t.reset : t.login}</ActionButton>{mode === "login" && <Button variant="text" onClick={() => changeMode("forgot")}>{t.forgot}</Button>}{mode !== "forgot" && <Button variant="text" disabled={action.busy || !token || !email} onClick={() => { void action.run(async () => { try { checked(await auth.sendVerificationEmail({ email, callbackURL: `${location.origin}${path("/account")}`, fetchOptions: { headers: { "x-turnstile-token": token } } })); action.setMessage(t.verificationSent); } finally { setToken(""); setVerificationKey((key) => key + 1); } }); }}>{t.resend}</Button>}</>}</Form></Card>}</>;
}

export function ResetPasswordPage() {
    const { t, path } = useLocale();
    const [params] = useSearchParams();
    const [password, setPassword] = useState("");
    const action = useAction();
    const token = params.get("token");
    return <Card className="auth-panel panel"><h1>{t.reset}</h1><Notice error={action.error} message={action.message} />{token ? <Form onSubmit={() => action.run(async () => { checked(await auth.resetPassword({ newPassword: password, token })); setPassword(""); action.setMessage(t.success); })}><Field label={t.newPassword} value={password} onChange={setPassword} type="password" required minLength={12} maxLength={128} autoComplete="new-password" /><ActionButton busy={action.busy} type="submit">{t.reset}</ActionButton></Form> : <p>{t.tokenMissing}</p>}<LinkButton href={path("/account")} variant="text">{t.login}</LinkButton></Card>;
}
