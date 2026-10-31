import { useEffect, useState } from "react";
import type { CommentingInfo, PageResult, ProductComment } from "../shared/contracts";
import { COMMENT_BODY_MAX_LENGTH } from "../shared/comments";
import { api, ApiError, send } from "./api";
import { Button, Card, Field, Icon } from "./material";
import { Verification } from "./turnstile";
import { ActionButton, Busy, Empty, Form, Notice, SignInPrompt, useAction, useLocale } from "./ui";

function CommentReport({ comment, onClose }: { comment: ProductComment; onClose: () => void }) {
    const { t } = useLocale();
    const [reason, setReason] = useState("");
    const action = useAction();
    return <Form onSubmit={() => action.run(async () => {
        await send(`/comments/${encodeURIComponent(comment.id)}/report`, "POST", { reason }, AbortSignal.timeout(15_000));
        setReason(""); action.setMessage(t.commentReportComplete);
    })}>
        <Field label={t.reason} value={reason} onChange={setReason} multiline required minLength={10} maxLength={2000} supportingText={t.reportHint} />
        <Notice error={action.error} message={action.message} />
        {action.error instanceof ApiError && action.error.status === 401 && <SignInPrompt />}
        <div className="button-row"><ActionButton busy={action.busy} type="submit">{t.submit}</ActionButton><Button variant="text" onClick={onClose}>{t.cancel}</Button></div>
    </Form>;
}

export function ProductComments({ productId }: { productId: string }) {
    const { t, locale } = useLocale();
    const [expanded, setExpanded] = useState(() => window.location.hash === "#comments");
    const [feed, setFeed] = useState<PageResult<ProductComment>>();
    const [feedError, setFeedError] = useState<unknown>();
    const [feedBusy, setFeedBusy] = useState(false);
    const [feedAttempt, setFeedAttempt] = useState(0);
    const [editorOpen, setEditorOpen] = useState(false);
    const [info, setInfo] = useState<CommentingInfo>();
    const [body, setBody] = useState("");
    const [token, setToken] = useState("");
    const [verificationKey, setVerificationKey] = useState(0);
    const [reporting, setReporting] = useState<string>();
    const action = useAction();
    useEffect(() => {
        if (!expanded) return;
        const controller = new AbortController();
        setFeedBusy(true); setFeedError(undefined);
        void api<PageResult<ProductComment>>(`/products/${encodeURIComponent(productId)}/comments`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
            .then(setFeed).catch((error: unknown) => { if (!controller.signal.aborted) setFeedError(error); })
            .finally(() => { if (!controller.signal.aborted) setFeedBusy(false); });
        return () => controller.abort();
    }, [expanded, productId, feedAttempt]);
    async function openEditor() {
        setEditorOpen(true); setExpanded(true); setInfo(undefined); setToken("");
        await action.run(async () => {
            const data = await api<CommentingInfo>(`/products/${encodeURIComponent(productId)}/commenting`, { signal: AbortSignal.timeout(15_000) });
            setInfo(data); setBody(data.comment?.body ?? ""); setToken(""); setVerificationKey((value) => value + 1);
        });
    }
    async function write(deleting = false) {
        await action.run(async () => {
            if (!info) return;
            if (!deleting && (!info.eligible || info.hidden)) throw new Error(t.commentRedemptionRequired);
            if (!deleting && !body.trim()) throw new Error(t.commentBodyHint);
            if (!deleting && !token) throw new Error(t.turnstileWait);
            const signal = AbortSignal.timeout(15_000);
            try {
                if (deleting && info.comment) {
                    await send(`/comments/${encodeURIComponent(info.comment.id)}`, "DELETE", undefined, signal);
                    setInfo({ ...info, comment: null }); setBody(""); action.setMessage(t.commentDeleted);
                } else {
                    const comment = await send<ProductComment>(info.comment ? `/comments/${encodeURIComponent(info.comment.id)}` : `/products/${encodeURIComponent(productId)}/comments`, info.comment ? "PUT" : "POST", { body: body.trim(), turnstileToken: token }, signal);
                    setInfo({ ...info, comment }); setBody(comment.body); action.setMessage(t.commentSaved);
                }
                setFeedAttempt((value) => value + 1);
            } catch (error) {
                if (signal.aborted) throw new Error(t.commentWriteTimeout);
                throw error;
            } finally { setToken(""); setVerificationKey((value) => value + 1); }
        });
    }
    async function more() {
        if (!feed?.nextCursor || feedBusy) return;
        setFeedBusy(true); setFeedError(undefined);
        try {
            const next = await api<PageResult<ProductComment>>(`/products/${encodeURIComponent(productId)}/comments?cursor=${encodeURIComponent(feed.nextCursor)}`, { signal: AbortSignal.timeout(15_000) });
            setFeed((previous) => ({ items: [...(previous?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
        } catch (error) { setFeedError(error); } finally { setFeedBusy(false); }
    }
    return <section className="product-comments" id="comments" aria-label={t.comments}>
        <div className="section-heading"><h2>{t.comments}</h2><div className="button-row">
            {!expanded && <Button variant="outlined" onClick={() => setExpanded(true)}>{t.viewComments}</Button>}
            <ActionButton busy={action.busy} variant="tonal" onClick={() => { void openEditor(); }}>{info?.comment ? t.editMyComment : t.writeComment}</ActionButton>
        </div></div>
        {editorOpen && <Card className="comment-editor">
            <Notice error={action.error} message={action.message} />
            {action.error instanceof ApiError && action.error.status === 401 ? <SignInPrompt />
                : !info ? action.busy && <Busy />
                    : <>
                        {info.hidden ? <p>{t.commentModerated}</p> : !info.eligible ? <p>{t.commentRedemptionRequired}</p> : <Form onSubmit={() => write()}>
                            <Field label={t.commentBody} value={body} onChange={setBody} multiline required maxLength={COMMENT_BODY_MAX_LENGTH} supportingText={t.commentBodyHint} disabled={action.busy} />
                            <Verification key={verificationKey} action="comment" size="compact" onToken={setToken} t={t} />
                            <ActionButton busy={action.busy} type="submit" disabled={!token || !body.trim()}>{info.comment ? t.saveComment : t.postComment}</ActionButton>
                        </Form>}
                        {info.hidden && info.comment && <Field label={t.commentBody} value={info.comment.body} onChange={() => {}} multiline readOnly />}
                        {info.comment && <ActionButton busy={action.busy} variant="text" onClick={() => { void write(true); }}>{t.deleteMyComment}</ActionButton>}
                    </>}
        </Card>}
        {expanded && <div className="form-stack">
            <Notice error={feedError} />
            {Boolean(feedError) && <Button variant="outlined" disabled={feedBusy} onClick={() => setFeedAttempt((value) => value + 1)}>{t.retryLoad}</Button>}
            {feed?.items.map((comment) => <Card role="article" className="comment-item" id={`comment-${comment.id}`} key={comment.id}>
                <div className="section-heading"><h3>{comment.authorName}</h3><span className="summary-label"><Icon name="verified" /><span>{t.verifiedRedemption}</span></span></div>
                <p className="quiet-note"><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString(locale)}</time>{comment.updatedAt !== comment.createdAt && ` · ${t.commentEdited}`}</p>
                <p className="comment-body">{comment.body}</p>
                <Button variant="text" onClick={() => setReporting(reporting === comment.id ? undefined : comment.id)}>{t.reportComment}</Button>
                {reporting === comment.id && <CommentReport comment={comment} onClose={() => setReporting(undefined)} />}
            </Card>)}
            {feedBusy && <Busy />}
            {!feedBusy && !feedError && feed?.items.length === 0 && <Empty>{t.commentsEmpty}</Empty>}
            {feed?.nextCursor && <ActionButton busy={feedBusy} variant="outlined" onClick={() => { void more(); }}>{t.loadMore}</ActionButton>}
        </div>}
    </section>;
}
