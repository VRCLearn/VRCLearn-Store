import { useEffect, useRef, useState } from "react";
import { CATEGORIES, type Locale, type MerchantProduct, type ProductInput, type Region, type ShopInput, type Workspace } from "../shared/contracts";
import { api, ApiError, send } from "./api";
import { Card, Button, Check, Field, Icon, IconButton, LinkButton, List, ListItem } from "./material";
import { Verification } from "./turnstile";
import { ActionButton, Busy, Empty, Form, Notice, Select, SignInPrompt, statusLabel, useAction, useLocale } from "./ui";

function split(value: string): string[] { return [...new Set(value.split(/[,，]/).map((part) => part.trim()).filter(Boolean))]; }
const blankProduct: ProductInput = {
    title: "", language: "en", summary: "", description: "", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: null, currency: "USD", purchaseUrl: "", mediaIds: [], r18: false,
};

function ShopForm({ initial, enrolled, onDone }: { initial?: ShopInput; enrolled: boolean; onDone: () => Promise<void> }) {
    const { t } = useLocale();
    const [shop, setShop] = useState<ShopInput>(initial ?? { name: "", description: "", websiteUrl: "" });
    const action = useAction();
    return <Form onSubmit={() => action.run(async () => { await send(enrolled ? "/merchant/shop" : "/merchant/enroll", enrolled ? "PUT" : "POST", shop); action.setMessage(t.success); await onDone(); })}><Field label={t.shopName} value={shop.name} onChange={(name) => setShop((current) => ({ ...current, name }))} maxLength={100} required /><Field label={t.website} value={shop.websiteUrl} onChange={(websiteUrl) => setShop((current) => ({ ...current, websiteUrl }))} type="url" maxLength={2048} required /><Field label={t.shopDescription} value={shop.description} onChange={(description) => setShop((current) => ({ ...current, description }))} multiline maxLength={2000} required /><Notice error={action.error} message={action.message} /><ActionButton busy={action.busy} type="submit">{enrolled ? t.editShop : t.enroll}</ActionButton>{enrolled && <p className="quiet-note">{t.shopReview}</p>}</Form>;
}

function PermissionForm({ workspace, onDone }: { workspace: Workspace; onDone: () => Promise<void> }) {
    const { t } = useLocale();
    const [region, setRegion] = useState<Region>("cn");
    const [reason, setReason] = useState("");
    const action = useAction();
    return <Card className="panel"><h2>{t.permissions}</h2><div className="permission-grid">{(["cn", "intl"] as const).map((area) => { const permission = workspace.permissions.find((item) => item.region === area); return <Card key={area} className="permission-card"><strong>{t[area]}</strong><span className={`status-pill ${permission?.status ?? ""}`}>{permission ? statusLabel(t, permission.status) : "—"}</span>{permission?.reason && <p>{permission.reason}</p>}</Card>; })}</div><details className="permission-application" open={!workspace.permissions.length}><summary><Icon name="add" />{t.requestPermission}</summary><Form onSubmit={() => action.run(async () => { await send("/merchant/permissions", "POST", { region, reason }); setReason(""); action.setMessage(t.success); await onDone(); })}><Select label={t.selectRegions} value={region} onChange={(value) => setRegion(value as Region)} options={[{ value: "cn", label: t.cn }, { value: "intl", label: t.intl }]} /><Field label={t.reason} value={reason} onChange={setReason} multiline required maxLength={2000} supportingText={t.permissionReason} /><Notice error={action.error} message={action.message} /><ActionButton busy={action.busy} type="submit" disabled={workspace.permissions.some((permission) => permission.region === region && ["approved", "pending"].includes(permission.status))}>{t.requestPermission}</ActionButton></Form></details></Card>;
}

function ProductEditor({ product, permissions, onSaved, onDone }: { product?: MerchantProduct; permissions: Workspace["permissions"]; onSaved: (id: string) => Promise<void>; onDone: () => Promise<void> }) {
    const { t, locale } = useLocale();
    const [content, setContent] = useState<ProductInput>(() => product?.content ?? { ...blankProduct, language: locale });
    const [tags, setTags] = useState(content.tags.join(", "));
    const [models, setModels] = useState(content.compatibleModels.join(", "));
    const [allAges, setAllAges] = useState(false);
    const [regions, setRegions] = useState<Region[]>(product?.publishedRegions ?? []);
    const [file, setFile] = useState<File>();
    const fileInput = useRef<HTMLInputElement>(null);
    const [uploadVisible, setUploadVisible] = useState(false);
    const [submitVisible, setSubmitVisible] = useState(false);
    const [uploadToken, setUploadToken] = useState("");
    const [submitToken, setSubmitToken] = useState("");
    const [uploadKey, setUploadKey] = useState(0);
    const [submitKey, setSubmitKey] = useState(0);
    const action = useAction();
    const locked = product?.status === "pending";
    const [dirty, setDirty] = useState(!product);
    function change<K extends keyof ProductInput>(key: K, value: ProductInput[K]) { setContent((current) => ({ ...current, [key]: value })); setDirty(true); }
    async function save() {
        await action.run(async () => {
            if (!allAges) throw new Error(t.allAgesRequired);
            const payload = { ...content, tags: split(tags), compatibleModels: split(models), r18: false };
            const result = await send<{ id: string; revisionId: string }>(product ? `/merchant/products/${encodeURIComponent(product.id)}` : "/merchant/products", product ? "PUT" : "POST", payload);
            setDirty(false); action.setMessage(t.success); await onSaved(result.id);
        });
    }
    async function upload() {
        await action.run(async () => {
            if (!file || !product) return;
            if (!uploadToken) throw new Error(t.turnstileWait);
            if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error(t.uploadHint);
            try {
                const uploaded = await api<{ id: string; previewUrl: string }>("/merchant/uploads", { method: "POST", body: file, headers: { "Content-Type": file.type, "x-product-id": product.id, "x-file-name": file.name, "x-turnstile-token": uploadToken, "Idempotency-Key": crypto.randomUUID() } });
                change("mediaIds", [...content.mediaIds, uploaded.id]); setFile(undefined); setUploadVisible(false); action.setMessage(t.success);
            } finally { setUploadToken(""); setUploadKey((key) => key + 1); }
        });
    }
    return <Card className="panel editor-panel"><div className="section-heading"><h2>{product ? t.edit : t.newProduct}</h2>{product && <span className={`status-pill ${product.status}`}>{statusLabel(t, product.status)}</span>}</div>{locked && <p className="notice">{t.pendingImmutable}</p>}{product?.publishedRegions.length ? <p className="quiet-note">{t.existingVersion}</p> : null}{product?.reviewReason && <p className="notice">{product.reviewReason}</p>}<Notice error={action.error} message={action.message} /><Form onSubmit={save}><h3 className="editor-section-heading">{t.productBasics}</h3><div className="form-columns"><Field label={t.title} value={content.title} onChange={(value) => change("title", value)} required maxLength={160} disabled={locked} /><Select disabled={locked} label={t.sourceLanguage} value={content.language} onChange={(value) => change("language", value as Locale)} options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "ja", label: "日本語" }]} /><Select disabled={locked} label={t.category} value={content.category} onChange={(value) => change("category", value as ProductInput["category"])} options={CATEGORIES.map((value) => ({ value, label: t[value] }))} /><Select disabled={locked} label={t.pricing} value={content.pricing} onChange={(value) => { change("pricing", value as ProductInput["pricing"]); if (value === "free") { change("price", null); change("currency", null); } else { change("currency", "USD"); } }} options={[{ value: "free", label: t.free }, { value: "paid", label: t.paid }]} />{content.pricing === "paid" && <><Field label={t.price} value={content.price === null ? "" : String(content.price)} onChange={(value) => change("price", value === "" ? null : Number(value))} type="number" required disabled={locked} /><Field label={t.currency} value={content.currency ?? ""} onChange={(value) => change("currency", value.toUpperCase())} maxLength={3} minLength={3} required disabled={locked} /></>}</div><Field label={t.summary} value={content.summary} onChange={(value) => change("summary", value)} maxLength={400} required disabled={locked} /><Field label={t.description} value={content.description} onChange={(value) => change("description", value)} multiline maxLength={12000} required disabled={locked} /><Field label={t.purchaseUrl} value={content.purchaseUrl} onChange={(value) => change("purchaseUrl", value)} type="url" required maxLength={2048} disabled={locked} /><h3 className="editor-section-heading">{t.compatibility}</h3><div className="form-columns"><Field label={t.tags} value={tags} onChange={(value) => { setTags(value); setDirty(true); }} maxLength={500} supportingText={t.commaHint} disabled={locked} /><Field label={t.models} value={models} onChange={(value) => { setModels(value); setDirty(true); }} maxLength={1000} supportingText={t.commaHint} disabled={locked} /></div><div className="button-row">{(["pc", "android"] as const).map((platform) => <Check key={platform} checked={content.platforms.includes(platform)} disabled={locked} onChange={(checked) => change("platforms", checked ? [...content.platforms, platform] : content.platforms.filter((item) => item !== platform))}>{platform === "pc" ? "PC" : "Android"}</Check>)}</div><Check checked={allAges} onChange={setAllAges} disabled={locked}>{t.allAges}</Check><ActionButton busy={action.busy} type="submit" disabled={locked || !allAges}>{t.saveDraft}</ActionButton></Form><section className="editor-subsection"><h3>{t.image}</h3><p className="quiet-note">{t.uploadHint}</p><div className="upload-previews">{content.mediaIds.map((id) => <figure key={id}><img src={`/api/v1/merchant/media/${encodeURIComponent(id)}`} alt={t.privatePreview} width="144" height="108" /><IconButton icon="close" label={t.deleteImage} disabled={locked || action.busy} onClick={() => change("mediaIds", content.mediaIds.filter((item) => item !== id))} /></figure>)}</div>{product && !locked && content.mediaIds.length < 10 && <Button variant="outlined" onClick={() => setUploadVisible(!uploadVisible)}>{t.upload}</Button>}{!product && <p className="quiet-note">{t.saveBeforeUpload}</p>}{uploadVisible && <Form onSubmit={upload}><div className="file-picker"><input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp" aria-label={t.upload} onChange={(event) => setFile(event.target.files?.[0])} /><Button variant="outlined" icon="image" onClick={() => fileInput.current?.click()}>{t.chooseImage}</Button><span>{file?.name ?? t.imageNotChosen}</span></div><Verification key={uploadKey} action="upload" onToken={setUploadToken} t={t} /><ActionButton busy={action.busy} type="submit" disabled={!file || !uploadToken}>{t.upload}</ActionButton></Form>}</section>{product && <section className="editor-subsection"><h3>{t.selectRegions}</h3><div className="button-row">{(["cn", "intl"] as const).map((region) => <Check key={region} checked={regions.includes(region)} disabled={locked || !permissions.some((permission) => permission.region === region && permission.status === "approved")} onChange={(checked) => setRegions((current) => checked ? [...current, region] : current.filter((item) => item !== region))}>{t[region]}</Check>)}</div>{product.publishedRegions.length > 0 && <p>{t.publishedRegions}: {product.publishedRegions.map((region) => t[region]).join(", ")}</p>}{product.requestedRegions.length > 0 && <p>{t.requestedRegions}: {product.requestedRegions.map((region) => t[region]).join(", ")}</p>}<div className="button-row">{locked ? <ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { await send(`/merchant/products/${encodeURIComponent(product.id)}/withdraw`, "POST"); await onDone(); }); }}>{t.withdraw}</ActionButton> : <Button disabled={action.busy || dirty || !regions.length} onClick={() => setSubmitVisible(!submitVisible)}>{t.submitReview}</Button>}{product.publishedRegions.map((region) => <ActionButton key={region} busy={action.busy} variant="text" onClick={() => { void action.run(async () => { await send(`/merchant/products/${encodeURIComponent(product.id)}/unpublish`, "POST", { region }); await onDone(); }); }}>{t.unpublish}: {t[region]}</ActionButton>)}</div>{dirty && <p className="quiet-note">{t.saveBeforeSubmit}</p>}{submitVisible && !locked && <Form onSubmit={() => action.run(async () => { if (!submitToken) throw new Error(t.turnstileWait); try { await send(`/merchant/products/${encodeURIComponent(product.id)}/submit`, "POST", { regions, turnstileToken: submitToken }); setSubmitVisible(false); await onDone(); } finally { setSubmitToken(""); setSubmitKey((key) => key + 1); } })}><Verification key={submitKey} action="submit" onToken={setSubmitToken} t={t} /><ActionButton busy={action.busy} type="submit" disabled={!submitToken || dirty}>{t.confirm}</ActionButton></Form>}</section>}</Card>;
}

export function MerchantPage() {
    const { t, path } = useLocale();
    const [workspace, setWorkspace] = useState<Workspace>();
    const [selected, setSelected] = useState<string | null>(null);
    const [editProfile, setEditProfile] = useState(false);
    const action = useAction();
    async function load() { setWorkspace(await api<Workspace>("/merchant/workspace")); }
    useEffect(() => { void action.run(load); }, []);
    const product = workspace?.products.find((item) => item.id === selected);
    if (action.error instanceof ApiError && action.error.status === 401) return <><div className="page-heading"><h1>{t.merchant}</h1><p>{t.merchantIntro}</p></div><SignInPrompt /></>;
    return <><div className="page-heading"><p className="eyebrow">{t.community}</p><h1>{t.merchant}</h1><p>{t.merchantIntro}</p></div><Notice error={action.error} message={action.message} />{action.error && <LinkButton variant="text" href={path("/account")}>{t.account}</LinkButton>}{!workspace ? action.busy && <Busy /> : !workspace.shop ? <Card className="panel auth-panel"><h2>{t.enroll}</h2><ShopForm enrolled={false} onDone={load} /></Card> : <><Card className="panel"><div className="section-heading"><div><p className="eyebrow">{t.shop}</p><h2>{workspace.shop.name}</h2></div><Button variant="outlined" onClick={() => setEditProfile(!editProfile)}>{t.profile}</Button></div>{editProfile && <ShopForm initial={workspace.shop} enrolled onDone={load} />}</Card><PermissionForm workspace={workspace} onDone={load} /><Card className="panel"><div className="section-heading"><div><h2>{t.products}</h2><p className="quiet-note">{t.merchantProductsHint}</p></div><div className="button-row"><ActionButton busy={action.busy} variant="text" onClick={() => { void action.run(load); }}>{t.refresh}</ActionButton><Button onClick={() => setSelected("new")}>{t.newProduct}</Button></div></div>{workspace.products.length ? <List className="merchant-products" label={t.products}>{workspace.products.map((item) => <ListItem key={item.id} className="merchant-product-item" selected={selected === item.id} onClick={() => setSelected(item.id)} headline={item.content.title || t.newProduct} supportingText={statusLabel(t, item.status)} icon="inventory" trailing={<Icon name="chevron_right" />} />)}</List> : <Empty />}</Card>{selected && <ProductEditor key={`${selected}:${product?.revisionId ?? "new"}:${product?.status ?? "new"}`} product={product} permissions={workspace.permissions} onSaved={async (id) => { await load(); setSelected(id); }} onDone={load} />}</>}</>;
}
