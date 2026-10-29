import { useEffect, useState, type ReactNode } from "react";
import { PLATFORM_LABELS, type ProductInput, type Region, type SessionUser, type ShopInput } from "../shared/contracts";
import { api, send } from "./api";
import { Card, Field, Icon, LinkButton, Tabs } from "./material";
import { ActionButton, Busy, currentUser, Empty, Form, Markdown, Notice, Select, SignInPrompt, statusLabel, useAction, useLocale } from "./ui";

interface ReviewQueue {
    permissions: { id: string; shopId: string; shopName: string; region: Region; reason: string }[];
    products: { id: string; productId: string; shopName: string; content: ProductInput; regions: { region: Region; status: string; reason: string }[]; canRetry: boolean }[];
    shops: { id: string; shopId: string; content: ShopInput }[];
    reports: { id: string; productId: string; reason: string; status: string }[];
}

function Decision({ endpoint, region, onDone }: { endpoint: string; region?: Region; onDone: () => Promise<void> }) {
    const { t } = useLocale();
    const [reason, setReason] = useState("");
    const action = useAction();
    async function decide(approve: boolean) {
        await action.run(async () => {
            if (!approve && !reason.trim()) throw new Error(t.reviewReason);
            await send(endpoint, "POST", { approve, reason, ...(region ? { region } : {}) });
            await onDone();
        });
    }
    return <div className="review-decision">{region && <strong>{t[region]}</strong>}<Field label={t.reviewReason} value={reason} onChange={setReason} maxLength={2000} /><Notice error={action.error} /><div className="button-row"><ActionButton busy={action.busy} onClick={() => { void decide(true); }}>{t.approve}</ActionButton><ActionButton busy={action.busy} variant="outlined" onClick={() => { void decide(false); }}>{t.reject}</ActionButton></div></div>;
}

function QueueSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
    return <Card className="panel"><div className="section-heading"><h2>{title} ({count})</h2></div>{count ? children : <Empty />}</Card>;
}

function RetryPublication({ id, regions, canRetry, onDone }: { id: string; regions: ReviewQueue["products"][number]["regions"]; canRetry: boolean; onDone: () => Promise<void> }) {
    const { t } = useLocale();
    const action = useAction();
    const approved = regions.find((region) => region.status === "approved");
    if (!canRetry || !approved) return null;
    return <div className="review-decision"><Notice error={action.error} /><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { await send(`/admin/revisions/${encodeURIComponent(id)}/review`, "POST", { region: approved.region, approve: true, reason: "" }); await onDone(); }); }}>{t.retryPublish}</ActionButton></div>;
}

function ProductReview({ content }: { content: ProductInput }) {
    const { t } = useLocale();
    return <div className="review-content"><h3>{content.title}</h3>{content.r18 && <p>{t.adult}</p>}<p>{content.summary}</p><Markdown source={content.description} /><dl className="spec-list"><div><dt>{t.category}</dt><dd>{t[content.category]}</dd></div><div><dt>{t.sourceLanguage}</dt><dd>{content.language}</dd></div><div><dt>{t.tags}</dt><dd>{content.tags.join(", ")}</dd></div><div><dt>{t.models}</dt><dd>{content.compatibleModels.join(", ")}</dd></div><div><dt>{t.support}</dt><dd>{content.platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ")}</dd></div><div><dt>{t.price}</dt><dd>{content.pricing === "free" ? t.free : `${content.currency} ${content.price}`}</dd></div><div><dt>{t.purchaseUrl}</dt><dd><a href={content.purchaseUrl} target="_blank" rel="noopener noreferrer nofollow">{content.purchaseUrl} ↗</a></dd></div></dl><div className="review-images">{content.mediaIds.map((id) => <a key={id} href={`/api/v1/merchant/media/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer"><img src={`/api/v1/merchant/media/${encodeURIComponent(id)}`} alt={t.privatePreview} loading="lazy" width="240" height="180" /></a>)}</div></div>;
}

function Moderation({ onDone }: { onDone: () => Promise<void> }) {
    const { t } = useLocale();
    const [kind, setKind] = useState("unpublish");
    const [id, setId] = useState("");
    const [reason, setReason] = useState("");
    const [region, setRegion] = useState<Region>("cn");
    const action = useAction();
    return <Card className="panel"><details className="moderation-tools"><summary><span className="summary-label"><Icon name="shield" /><span>{t.moderation}</span></span></summary><p className="quiet-note">{t.moderationHint}</p><Form onSubmit={() => action.run(async () => { const target = encodeURIComponent(id.trim()); if (!target || !reason.trim()) throw new Error(t.reason); const endpoint = kind === "unpublish" ? `/admin/products/${target}/unpublish` : kind === "revoke" ? `/admin/shops/${target}/revoke` : `/admin/users/${target}/ban`; await send(endpoint, "POST", { reason, ...(kind === "unpublish" || kind === "revoke" ? { region } : { banned: kind === "ban" }) }); setId(""); setReason(""); action.setMessage(t.success); await onDone(); })}><Select label={t.moderation} value={kind} onChange={setKind} options={[{ value: "unpublish", label: t.unpublish }, { value: "revoke", label: t.revokePermission }, { value: "ban", label: t.ban }, { value: "unban", label: t.unban }]} /><Field label={kind === "unpublish" ? t.productId : kind === "revoke" ? t.shopId : t.userId} value={id} onChange={setId} required maxLength={128} />{(kind === "unpublish" || kind === "revoke") && <Select label={t.selectRegions} value={region} onChange={(value) => setRegion(value as Region)} options={[{ value: "cn", label: t.cn }, { value: "intl", label: t.intl }]} />}<Field label={t.reason} value={reason} onChange={setReason} required multiline maxLength={2000} /><Notice error={action.error} message={action.message} /><ActionButton busy={action.busy} type="submit">{t.confirm}</ActionButton></Form></details></Card>;
}

export function AdminPage() {
    const { t } = useLocale();
    const [user, setUser] = useState<SessionUser | null>();
    const [queue, setQueue] = useState<ReviewQueue>();
    const [section, setSection] = useState("products");
    const action = useAction();
    async function load() { setQueue(await api<ReviewQueue>("/admin/queue")); }
    useEffect(() => { void action.run(async () => { const current = await currentUser(); setUser(current); if (current?.role === "admin" && !current.banned) await load(); }); }, []);
    return <>
        <div className="page-heading"><div className="section-heading"><div><p className="eyebrow">VRCLearn Store</p><h1>{t.admin}</h1></div>{user?.role === "admin" && !user.banned && <ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(load); }}>{t.refresh}</ActionButton>}</div></div>
        <Notice error={action.error} />
        {action.busy && !queue ? <Busy /> : !user || user.role !== "admin" || user.banned ? <SignInPrompt admin /> : queue ? <>
            <Tabs tabs={[{ value: "products", label: `${t.productsQueue} (${queue.products.length})` }, { value: "permissions", label: `${t.permissionsQueue} (${queue.permissions.length})` }, { value: "shops", label: `${t.shopsQueue} (${queue.shops.length})` }, { value: "reports", label: `${t.reportsQueue} (${queue.reports.length})` }]} value={section} onChange={setSection} />
            <div className="admin-layout"><div className="review-queues">
                {section === "permissions" && <QueueSection title={t.permissionsQueue} count={queue.permissions.length}>{queue.permissions.map((application) => <Card role="article" className="review-item" key={application.id}><h3>{application.shopName} · {t[application.region]}</h3><small>{t.shopId}: {application.shopId}</small><p>{application.reason}</p><Decision endpoint={`/admin/permissions/${encodeURIComponent(application.id)}/review`} onDone={load} /></Card>)}</QueueSection>}
                {section === "products" && <QueueSection title={t.productsQueue} count={queue.products.length}>{queue.products.map((submission) => <Card className="review-item" key={submission.id}><details className="review-details"><summary><strong>{submission.content.title}</strong><span>{submission.shopName} · {submission.regions.map((item) => `${t[item.region]} · ${statusLabel(t, item.status)}`).join(" / ")}</span></summary><small>{t.productId}: {submission.productId}</small><ProductReview content={submission.content} />{submission.regions.filter((item) => item.status === "pending").map((item) => <Decision key={item.region} endpoint={`/admin/revisions/${encodeURIComponent(submission.id)}/review`} region={item.region} onDone={load} />)}<RetryPublication id={submission.id} regions={submission.regions} canRetry={submission.canRetry} onDone={load} /></details></Card>)}</QueueSection>}
                {section === "shops" && <QueueSection title={t.shopsQueue} count={queue.shops.length}>{queue.shops.map((submission) => <Card role="article" className="review-item" key={submission.id}><h3>{submission.content.name}</h3><small>{t.shopId}: {submission.shopId}</small><p>{submission.content.description}</p><a href={submission.content.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">{submission.content.websiteUrl}</a><Decision endpoint={`/admin/shops/${encodeURIComponent(submission.id)}/review`} onDone={load} /></Card>)}</QueueSection>}
                {section === "reports" && <QueueSection title={t.reportsQueue} count={queue.reports.length}>{queue.reports.map((report) => <ReportItem key={report.id} report={report} onDone={load} />)}</QueueSection>}
            </div><aside><Moderation onDone={load} /></aside></div>
        </> : null}
    </>;
}

function ReportItem({ report, onDone }: { report: ReviewQueue["reports"][number]; onDone: () => Promise<void> }) {
    const { t, path } = useLocale();
    const [reason, setReason] = useState("");
    const action = useAction();
    return <Card role="article" className="review-item"><h3>{t.productId}: {report.productId}</h3><LinkButton href={path(`/products/${encodeURIComponent(report.productId)}`)} target="_blank" variant="text" icon="open_in_new">{t.details}</LinkButton><p>{report.reason}</p><Form onSubmit={() => action.run(async () => { await send(`/admin/reports/${encodeURIComponent(report.id)}/resolve`, "POST", { reason }); await onDone(); })}><Field label={t.reason} value={reason} onChange={setReason} required maxLength={2000} /><Notice error={action.error} /><ActionButton busy={action.busy} type="submit">{t.resolve}</ActionButton></Form></Card>;
}
