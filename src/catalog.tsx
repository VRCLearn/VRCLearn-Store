import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { CATEGORIES, PLATFORMS, PLATFORM_LABELS, type PageResult, type Product, type Shop } from "../shared/contracts";
import { api, ApiError, localizedError, send } from "./api";
import { Card, Button, Field, FilterChip, Icon, IconButton, LinkButton, NavigationChip } from "./material";
import { ActionButton, Busy, Empty, Form, Markdown, Notice, Price, ProductCard, Select, SignInPrompt, useAction, useLocale } from "./ui";

declare global {
    interface Window {
        __STORE_DATA__?: { kind: "product" | "shop"; data: Product | Shop; locale: string };
    }
}

export function SearchPage() {
    const { t } = useLocale();
    const [params, setParams] = useSearchParams();
    const [filters, setFilters] = useState(() => Object.fromEntries(params));
    const [result, setResult] = useState<PageResult<Product>>({ items: [], nextCursor: null });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>();
    const [validation, setValidation] = useState("");
    const [retry, setRetry] = useState(0);
    function field(key: string, value: string) {
        setFilters((previous) => ({ ...previous, [key]: value }));
        setValidation("");
    }
    useEffect(() => {
        const controller = new AbortController();
        setFilters(Object.fromEntries(params));
        setBusy(true);
        setError(undefined);
        void api<PageResult<Product>>(`/products?${params.toString()}`, { signal: controller.signal })
            .then(setResult)
            .catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [params, retry]);
    function submit() {
        if (busy) return;
        if (filters.q && (filters.q.trim().length < 2 || filters.q.length > 80)) { setValidation(t.searchHint); return; }
        if (filters.sort?.startsWith("price") && !filters.currency) { setValidation(t.priceHint); return; }
        setValidation("");
        const next = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([key, value]) => key !== "cursor" && value)));
        if (next.toString() === params.toString()) setRetry((current) => current + 1);
        else setParams(next);
    }
    function category(value: string) {
        const next = new URLSearchParams(params);
        next.delete("cursor");
        if (value) next.set("category", value); else next.delete("category");
        if (next.toString() !== params.toString()) setParams(next);
    }
    function clearFilters() {
        setFilters({});
        setValidation("");
        if (params.size) setParams({});
        else setRetry((current) => current + 1);
    }
    async function more() {
        if (!result.nextCursor || busy) return;
        setBusy(true); setError(undefined);
        try {
            const query = new URLSearchParams(params); query.set("cursor", result.nextCursor);
            const next = await api<PageResult<Product>>(`/products?${query}`);
            setResult((previous) => ({ items: [...previous.items, ...next.items], nextCursor: next.nextCursor }));
        } catch (caught) { setError(caught); } finally { setBusy(false); }
    }
    const activeFilters = Object.entries(filters).filter(([key, value]) => !["q", "category", "sort", "cursor"].includes(key) && value).length;
    return <>
        <div className="page-heading search-intro">
            <p className="eyebrow">VRCLearn Store</p>
            <h1>{t.filterHeading}</h1>
            <p>{t.searchSubtitle}</p>
        </div>
        <Form className="search-toolbar" onSubmit={submit}>
            <Field className="catalog-search-field" label={t.keyword} value={filters.q ?? ""} onChange={(value) => field("q", value)} maxLength={80} leadingIcon="search" />
            <Button type="submit" icon="search" disabled={busy}>{t.apply}</Button>
        </Form>
        {validation && <Notice error={new Error(validation)} />}
        <div className="category-chip-row" role="group" aria-label={t.category}>
            <FilterChip label={t.all} selected={!params.get("category")} onClick={() => category("")} />
            {CATEGORIES.map((value) => <FilterChip key={value} label={t[value]} selected={params.get("category") === value} onClick={() => category(params.get("category") === value ? "" : value)} />)}
        </div>
        <div className="catalog-layout">
            <aside aria-label={t.filters}><Card className="filter-panel">
                <div className="filter-panel-heading"><h2>{t.filters}</h2><Button variant="text" onClick={clearFilters} disabled={busy || (!params.size && !Object.values(filters).some(Boolean))}>{t.clearFilters}</Button></div>
                <Form onSubmit={submit}>
                    <Select label={t.platform} value={filters.platform ?? ""} onChange={(value) => field("platform", value)} options={[{ value: "", label: t.all }, ...PLATFORMS.map((value) => ({ value, label: PLATFORM_LABELS[value] }))]} />
                    <Select label={t.pricing} value={filters.pricing ?? ""} onChange={(value) => field("pricing", value)} options={[{ value: "", label: t.all }, { value: "free", label: t.free }, { value: "paid", label: t.paid }]} />
                    <Select label={t.sort} value={filters.sort ?? "latest"} onChange={(value) => field("sort", value)} options={[{ value: "relevance", label: t.relevance }, { value: "latest", label: t.newest }, { value: "price_asc", label: t.priceAsc }, { value: "price_desc", label: t.priceDesc }]} />
                    <details className="advanced-filters" open={activeFilters > 0 || filters.sort?.startsWith("price") ? true : undefined}>
                        <summary>{t.moreFilters}{activeFilters ? <span className="filter-count" aria-label={`${t.filters}: ${activeFilters}`}>({activeFilters})</span> : null}<Icon name="expand_more" /></summary>
                        <div className="advanced-filter-fields">
                            <Field label={t.model} value={filters.model ?? ""} onChange={(value) => field("model", value)} maxLength={100} />
                            <Field label={t.tag} value={filters.tag ?? ""} onChange={(value) => field("tag", value)} maxLength={50} />
                            <Field label={t.currency} value={filters.currency ?? ""} onChange={(value) => field("currency", value.toUpperCase())} maxLength={3} />
                        </div>
                    </details>
                    <ActionButton busy={busy} type="submit" variant="tonal">{t.applyFilters}</ActionButton>
                </Form>
            </Card></aside>
            <section className="catalog-results" aria-label={t.products} aria-busy={busy}>
                <div className="result-toolbar"><h2>{t.searchResults}</h2>{!busy && !error && result.items.length > 0 && <span>{result.items.length} {t.resultsLoaded}</span>}</div>
                {error ? <Card className="catalog-status" role="alert">
                    <div className="catalog-status-icon"><Icon name="cloud_off" size={32} /></div>
                    <h2>{t.catalogUnavailable}</h2>
                    <p>{localizedError(error, t)}</p>
                    <p className="quiet-note">{t.catalogUnavailableHint}</p>
                    <Button variant="tonal" icon="refresh" disabled={busy} onClick={() => setRetry((current) => current + 1)}>{t.retryLoad}</Button>
                </Card> : busy && !result.items.length ? <div className="catalog-loading"><Busy /><div className="catalog-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="product-skeleton" key={index}><div className="skeleton-image" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>)}</div></div> : result.items.length ? <div className="product-grid">{result.items.map((product) => <ProductCard key={product.id} product={product} />)}</div> : <Card className="catalog-status">
                    <div className="catalog-status-icon"><Icon name="search_off" size={32} /></div>
                    <h2>{t.noResultsTitle}</h2>
                    <p>{t.noResultsHint}</p>
                    {params.size > 0 && <Button variant="outlined" onClick={clearFilters}>{t.clearFilters}</Button>}
                </Card>}
                {result.nextCursor && !error && <div className="load-more"><ActionButton busy={busy} variant="outlined" onClick={() => { void more(); }}>{t.loadMore}</ActionButton></div>}
            </section>
        </div>
    </>;
}

function initialProduct(id: string): Product | undefined {
    const initial = window.__STORE_DATA__;
    return initial?.kind === "product" && initial.data.id === id ? initial.data as Product : undefined;
}

export function ProductPage() {
    const { id = "" } = useParams();
    const { t, path } = useLocale();
    const [product, setProduct] = useState<Product | undefined>(() => initialProduct(id));
    const [error, setError] = useState<unknown>();
    const [activeImage, setActiveImage] = useState(0);
    const [reporting, setReporting] = useState(false);
    const [retry, setRetry] = useState(0);
    const [reason, setReason] = useState("");
    const [saved, setSaved] = useState(false);
    const action = useAction();
    useEffect(() => {
        setActiveImage(0); setSaved(false); setProduct(initialProduct(id)); setError(undefined);
        if (initialProduct(id)) return;
        const controller = new AbortController();
        void api<Product>(`/products/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setProduct).catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught); });
        return () => controller.abort();
    }, [id, retry]);
    if (error) return <Card className="catalog-status" role="alert"><div className="catalog-status-icon"><Icon name="cloud_off" size={32} /></div><h1>{error instanceof ApiError && error.status === 404 ? t.unavailable : t.catalogUnavailable}</h1><p>{localizedError(error, t)}</p><Button variant="tonal" icon="refresh" onClick={() => setRetry((current) => current + 1)}>{t.retryLoad}</Button></Card>;
    if (!product) return <Busy />;
    const domain = (() => { try { return new URL(product.purchaseUrl).hostname; } catch { return ""; } })();
    return <><nav className="breadcrumbs"><Link to={path("/search")}>{t.browse}</Link><span aria-hidden="true">/</span><span>{t[product.category]}</span></nav><div className="detail-layout"><section className="gallery" aria-label={t.image}><div className="main-image">{product.images[activeImage] ? <img src={product.images[activeImage]} alt={product.title} width="960" height="720" /> : <div className="image-placeholder"><Icon name={product.category} size={48} /></div>}</div>{product.images.length > 1 && <div className="thumbnails">{product.images.map((url, index) => <IconButton key={url} variant="outlined" className="gallery-thumbnail" label={`${t.image} ${index + 1}`} aria-pressed={activeImage === index} onClick={() => setActiveImage(index)}><img src={url} alt="" width="96" height="72" /></IconButton>)}</div>}</section><section className="detail-summary"><Link className="seller-link" to={path(`/shops/${encodeURIComponent(product.shopId)}`)}>{product.shopName}</Link><h1>{product.title}</h1>{product.r18 && <p>{t.adult}</p>}<p className="lead">{product.summary}</p><div className="detail-price"><span>{t.referencePrice}</span><Price product={product} /></div><LinkButton className="purchase-link" href={product.purchaseUrl} target="_blank" rel="noopener noreferrer nofollow" icon="open_in_new">{t.purchase}</LinkButton><small className="destination">{domain}</small><p className="quiet-note">{t.outboundNote}</p><div className="button-row"><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { await send(`/favorites/${encodeURIComponent(id)}`, saved ? "DELETE" : "PUT"); setSaved(!saved); }); }}>{saved ? t.saved : t.favorites}</ActionButton><Button variant="text" onClick={() => setReporting(!reporting)}>{t.report}</Button></div><Notice error={action.error} message={action.message} />{reporting && <Form onSubmit={() => action.run(async () => { await send("/reports", "POST", { productId: id, reason }); setReporting(false); setReason(""); action.setMessage(t.success); })}><Field label={t.reason} value={reason} onChange={setReason} multiline required maxLength={2000} supportingText={t.reportHint} /><ActionButton busy={action.busy} type="submit">{t.submit}</ActionButton></Form>}<dl className="spec-list"><div><dt>{t.support}</dt><dd>{product.platforms.map((platform) => PLATFORM_LABELS[platform]).join(" · ")}</dd></div><div><dt>{t.models}</dt><dd>{product.compatibleModels.join(", ") || "—"}</dd></div><div><dt>{t.sourceLanguage}</dt><dd>{product.language}</dd></div></dl></section></div><Card className="description-panel"><h2>{t.description}</h2><p className="quiet-note">{t.originalNote}</p><Markdown source={product.description} /><div className="tag-list">{product.tags.map((tag) => <NavigationChip key={tag} label={tag} href={path(`/search?tag=${encodeURIComponent(tag)}`)} />)}</div></Card></>;
}

export function ShopPage() {
    const { id = "" } = useParams();
    const { t } = useLocale();
    const initial = window.__STORE_DATA__;
    const [retry, setRetry] = useState(0);
    const [shop, setShop] = useState<Shop | undefined>(() => initial?.kind === "shop" && initial.data.id === id ? initial.data as Shop : undefined);
    const [products, setProducts] = useState<PageResult<Product>>({ items: [], nextCursor: null });
    const action = useAction();
    useEffect(() => {
        const controller = new AbortController();
        void action.run(async () => {
            const currentInitial = window.__STORE_DATA__;
            if (currentInitial?.kind === "shop" && currentInitial.data.id === id) setShop(currentInitial.data as Shop);
            else setShop(await api<Shop>(`/shops/${encodeURIComponent(id)}`, { signal: controller.signal }));
            setProducts(await api<PageResult<Product>>(`/shops/${encodeURIComponent(id)}/products`, { signal: controller.signal }));
        });
        return () => controller.abort();
    }, [id, retry]);
    return <>{action.error && <Card className="catalog-status" role="alert"><div className="catalog-status-icon"><Icon name="storefront" size={32} /></div><h2>{t.shopUnavailable}</h2><p>{localizedError(action.error, t)}</p><Button variant="tonal" icon="refresh" onClick={() => setRetry((current) => current + 1)}>{t.retryLoad}</Button></Card>}{shop ? <><Card className="shop-banner"><div className="shop-avatar" aria-hidden="true">{shop.name.slice(0, 1)}</div><div><p className="eyebrow">{t.seller}</p><h1>{shop.name}</h1><p>{shop.description}</p><a href={shop.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">{shop.websiteUrl} ↗</a></div></Card><h2>{t.products}</h2>{products.items.length ? <div className="product-grid">{products.items.map((product) => <ProductCard key={product.id} product={product} />)}</div> : !action.busy && !action.error && <Empty>{t.shopEmpty}</Empty>}{products.nextCursor && <div className="load-more"><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { const next = await api<PageResult<Product>>(`/shops/${encodeURIComponent(id)}/products?cursor=${encodeURIComponent(products.nextCursor ?? "")}`); setProducts((previous) => ({ items: [...previous.items, ...next.items], nextCursor: next.nextCursor })); }); }}>{t.loadMore}</ActionButton></div>}</> : action.busy && <Busy />}</>;
}

export function FavoritesPage() {
    const { t, path } = useLocale();
    const [result, setResult] = useState<PageResult<{ productId: string; product: Product | null }>>({ items: [], nextCursor: null });
    const action = useAction();
    useEffect(() => { void action.run(async () => setResult(await api("/favorites"))); }, []);
    if (action.error instanceof ApiError && action.error.status === 401) return <><div className="page-heading"><h1>{t.favorites}</h1></div><SignInPrompt /></>;
    return <><div className="page-heading"><h1>{t.favorites}</h1><p>{t.regionNote}</p></div><Notice error={action.error} message={action.message} />{action.busy && !result.items.length ? <Busy /> : result.items.length ? <div className="product-grid">{result.items.map((favorite) => <div key={favorite.productId}>{favorite.product ? <ProductCard product={favorite.product} /> : <Card className="panel"><p>{t.unavailable}</p></Card>}<div className="favorite-remove"><ActionButton busy={action.busy} variant="text" onClick={() => { void action.run(async () => { await send(`/favorites/${encodeURIComponent(favorite.productId)}`, "DELETE"); setResult((previous) => ({ ...previous, items: previous.items.filter((item) => item.productId !== favorite.productId) })); }); }}>{t.remove}</ActionButton></div></div>)}</div> : !action.error && <Card className="catalog-status"><div className="catalog-status-icon"><Icon name="favorite" size={32} /></div><h2>{t.emptyFavoritesTitle}</h2><p>{t.emptyFavoritesHint}</p><LinkButton href={path("/search")} icon="search">{t.browseCollection}</LinkButton></Card>}{result.nextCursor && <div className="load-more"><ActionButton busy={action.busy} variant="outlined" onClick={() => { void action.run(async () => { const next = await api<typeof result>(`/favorites?cursor=${encodeURIComponent(result.nextCursor ?? "")}`); setResult((previous) => ({ items: [...previous.items, ...next.items], nextCursor: next.nextCursor })); }); }}>{t.loadMore}</ActionButton></div>}</>;
}
