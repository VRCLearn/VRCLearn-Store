import { useEffect, useRef, useState } from "react";
import type { PageResult, Redemption, RedemptionInventory, SessionUser } from "../shared/contracts";
import { redemptionCodeSchema, redemptionEntriesSchema, REDEMPTION_CODE_MAX_LENGTH, REDEMPTION_CODE_MIN_LENGTH, REDEMPTION_IMPORT_MAX_BYTES } from "../shared/redemption";
import { api, ApiError, send } from "./api";
import { Button, Card, Dialog, Field, LinkButton } from "./material";
import { Verification } from "./turnstile";
import { ActionButton, Busy, currentUser, Empty, Form, Notice, SignInPrompt, useAction, useLocale } from "./ui";

function DeliveryContent({ redemption }: { redemption: Redemption }) {
    const { t } = useLocale();
    const action = useAction();
    return <div className="form-stack">
        <Field label={t.deliveryContent} value={redemption.content} onChange={() => {}} multiline readOnly />
        <div className="button-row"><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => {
            try { await navigator.clipboard.writeText(redemption.content); }
            catch { throw new Error(t.copyFailed); }
            action.setMessage(t.contentCopied);
        }); }}>{t.copyContent}</ActionButton></div>
        <Notice error={action.error} message={action.message} />
    </div>;
}

function RedemptionDialog({ productId, onClose }: { productId: string; onClose: () => void }) {
    const { t, path } = useLocale();
    const [user, setUser] = useState<SessionUser | null>();
    const [loadingError, setLoadingError] = useState<unknown>();
    const [attempt, setAttempt] = useState(0);
    const [code, setCode] = useState("");
    const [token, setToken] = useState("");
    const [verificationKey, setVerificationKey] = useState(0);
    const [result, setResult] = useState<Redemption>();
    const action = useAction();
    useEffect(() => {
        const controller = new AbortController();
        setLoadingError(undefined);
        void currentUser(controller.signal).then(setUser).catch((error: unknown) => { if (!controller.signal.aborted) setLoadingError(error); });
        return () => controller.abort();
    }, [attempt]);
    return <Dialog headline={result ? t.redemptionComplete : t.redeem} closeLabel={t.close} busy={action.busy} onClose={onClose}>
        {result ? <div className="form-stack"><DeliveryContent redemption={result} /><p>{t.redemptionSaved}</p><LinkButton href={path("/account#redemptions")} variant="tonal">{t.myRedemptions}</LinkButton></div>
            : loadingError ? <><Notice error={loadingError} /><Button variant="outlined" onClick={() => setAttempt((value) => value + 1)}>{t.retryLoad}</Button></>
                : user === undefined ? <Busy /> : !user ? <SignInPrompt /> : <Form onSubmit={() => action.run(async () => {
                    const parsed = redemptionCodeSchema.safeParse(code);
                    if (!parsed.success) throw new Error(t.redemptionCodeHint);
                    if (!token) throw new Error(t.turnstileWait);
                    const signal = AbortSignal.timeout(15_000);
                    try {
                        const receipt = await send<Redemption>(`/products/${encodeURIComponent(productId)}/redeem`, "POST", { code: parsed.data, turnstileToken: token }, signal);
                        setResult(receipt); setCode("");
                    } catch (error) {
                        if (signal.aborted) throw new Error(t.redemptionTimeout);
                        throw error;
                    } finally { setToken(""); setVerificationKey((value) => value + 1); }
                })}>
                    <p>{t.redeemHint}</p>
                    <Field label={t.redemptionCode} type="password" autoComplete="off" value={code} onChange={setCode} required minLength={REDEMPTION_CODE_MIN_LENGTH} maxLength={REDEMPTION_CODE_MAX_LENGTH} supportingText={t.redemptionCodeHint} disabled={action.busy} />
                    <Verification key={verificationKey} action="redeem" size="compact" onToken={setToken} t={t} />
                    <Notice error={action.error} />
                    <ActionButton busy={action.busy} type="submit" disabled={!token || !code.trim()}>{t.redeem}</ActionButton>
                </Form>}
    </Dialog>;
}

export function RedeemProduct({ productId }: { productId: string }) {
    const { t } = useLocale();
    const [open, setOpen] = useState(false);
    return <><Button icon="inventory" onClick={() => setOpen(true)}>{t.redeem}</Button>{open && <RedemptionDialog key={productId} productId={productId} onClose={() => setOpen(false)} />}</>;
}

export function RedemptionHistory() {
    const { t, locale } = useLocale();
    const [expanded, setExpanded] = useState(() => window.location.hash === "#redemptions");
    const [result, setResult] = useState<PageResult<Redemption>>();
    const [error, setError] = useState<unknown>();
    const [busy, setBusy] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!expanded) return;
        const controller = new AbortController();
        setBusy(true); setError(undefined);
        void api<PageResult<Redemption>>("/redemptions", { signal: controller.signal }).then(setResult)
            .catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [expanded, attempt]);
    async function more() {
        if (!result?.nextCursor || busy) return;
        setBusy(true); setError(undefined);
        try {
            const next = await api<PageResult<Redemption>>(`/redemptions?cursor=${encodeURIComponent(result.nextCursor)}`);
            setResult((previous) => ({ items: [...(previous?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
        } catch (caught) { setError(caught); } finally { setBusy(false); }
    }
    return <details id="redemptions" className="account-session-actions" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{t.myRedemptions}</summary>
        {expanded && <div className="form-stack">
            <p className="quiet-note">{t.redemptionHistoryHint}</p>
            <Notice error={error} />
            {Boolean(error) && <Button variant="outlined" onClick={() => setAttempt((value) => value + 1)} disabled={busy}>{t.retryLoad}</Button>}
            {result?.items.map((redemption) => <Card className="redemption-receipt" key={redemption.id}>
                <h3>{redemption.title}</h3><p><time dateTime={redemption.redeemedAt}>{new Date(redemption.redeemedAt).toLocaleString(locale)}</time></p>
                <DeliveryContent redemption={redemption} />
            </Card>)}
            {busy && <Busy />}
            {!busy && !error && result?.items.length === 0 && <Empty>{t.redemptionsEmpty}</Empty>}
            {result?.nextCursor && <ActionButton busy={busy} variant="outlined" onClick={() => { void more(); }}>{t.loadMore}</ActionButton>}
        </div>}
    </details>;
}

export function MerchantCodes({ productId }: { productId: string }) {
    const { t } = useLocale();
    const [expanded, setExpanded] = useState(false);
    const [inventory, setInventory] = useState<RedemptionInventory>();
    const [inventoryError, setInventoryError] = useState<unknown>();
    const [attempt, setAttempt] = useState(0);
    const [source, setSource] = useState("");
    const [token, setToken] = useState("");
    const [verificationKey, setVerificationKey] = useState(0);
    const fileInput = useRef<HTMLInputElement>(null);
    const action = useAction();
    useEffect(() => {
        if (!expanded) return;
        const controller = new AbortController();
        setInventoryError(undefined);
        void api<RedemptionInventory>(`/merchant/products/${encodeURIComponent(productId)}/codes`, { signal: controller.signal }).then(setInventory)
            .catch((caught: unknown) => { if (!controller.signal.aborted) setInventoryError(caught); });
        return () => controller.abort();
    }, [expanded, productId, attempt]);
    async function readFile(file?: File) {
        if (!file) return;
        setSource("");
        await action.run(async () => {
            if (file.size > REDEMPTION_IMPORT_MAX_BYTES) throw new Error(t.codeImportHint);
            const data = await file.text();
            try { redemptionEntriesSchema.parse(JSON.parse(data)); }
            catch { throw new Error(t.codeImportInvalid); }
            setSource(data);
        });
        if (fileInput.current) fileInput.current.value = "";
    }
    function example() {
        const url = URL.createObjectURL(new Blob([JSON.stringify([{ code: "REPLACE-WITH-UNIQUE-RANDOM-CODE", content: "https://example.com/your-private-download" }], null, 4)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = "redemption-codes-example.json";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return <section className="editor-subsection"><details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{t.codeInventory}</summary>
        {expanded && <div className="form-stack">
            <p>{t.codeInventoryHint}</p>
            <Notice error={inventoryError} />
            {inventory && <dl className="spec-list"><div><dt>{t.codesAvailable}</dt><dd>{inventory.available}</dd></div><div><dt>{t.codesRedeemed}</dt><dd>{inventory.redeemed}</dd></div><div><dt>{t.codesTotal}</dt><dd>{inventory.total}</dd></div></dl>}
            <Button variant="text" onClick={() => setAttempt((value) => value + 1)}>{t.refresh}</Button>
            <Form onSubmit={() => action.run(async () => {
                let entries: ReturnType<typeof redemptionEntriesSchema.parse>;
                try { entries = redemptionEntriesSchema.parse(JSON.parse(source)); }
                catch { throw new Error(t.codeImportInvalid); }
                if (!token) throw new Error(t.turnstileWait);
                const body = { entries, turnstileToken: token };
                if (new TextEncoder().encode(JSON.stringify(body)).byteLength > REDEMPTION_IMPORT_MAX_BYTES) throw new Error(t.codeImportHint);
                const signal = AbortSignal.timeout(15_000);
                try {
                    await send<{ imported: number }>(`/merchant/products/${encodeURIComponent(productId)}/codes`, "POST", body, signal);
                    setSource(""); action.setMessage(t.codeImportComplete); setAttempt((value) => value + 1);
                } catch (error) {
                    if (signal.aborted) throw new Error(t.codeImportTimeout);
                    if (error instanceof ApiError && error.status === 413) throw new Error(t.codeImportHint);
                    throw error;
                } finally { setToken(""); setVerificationKey((value) => value + 1); }
            })}>
                <input type="file" ref={fileInput} hidden accept=".json,application/json" aria-label={t.chooseCodeFile} onChange={(event) => { void readFile(event.target.files?.[0]); }} />
                <div className="button-row"><Button variant="outlined" disabled={action.busy} onClick={() => fileInput.current?.click()}>{t.chooseCodeFile}</Button><Button variant="text" onClick={example}>{t.codeImportExample}</Button></div>
                <Field label={t.codeImportData} value={source} onChange={setSource} multiline required maxLength={REDEMPTION_IMPORT_MAX_BYTES} supportingText={t.codeImportHint} disabled={action.busy} />
                <Verification key={verificationKey} action="import-codes" size="compact" onToken={setToken} t={t} />
                <Notice error={action.error} message={action.message} />
                <ActionButton busy={action.busy} type="submit" disabled={!token || !source.trim()}>{t.importCodes}</ActionButton>
            </Form>
        </div>}
    </details></section>;
}
