import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { CATEGORIES, type Category } from "../shared/contracts";
import { localeFromPath } from "./i18n";
import { Busy, LocaleContext, useLocale } from "./ui";
import { Card, Icon, IconButton, InteractionState, LinkButton, MenuButton } from "./material";
import { ThemeProvider } from "./theme/provider";
import "./styles.css";

const AccountPage = lazy(() => import("./account").then((module) => ({ default: module.AccountPage })));
const ResetPasswordPage = lazy(() => import("./account").then((module) => ({ default: module.ResetPasswordPage })));
const AdminPage = lazy(() => import("./admin").then((module) => ({ default: module.AdminPage })));
const MerchantPage = lazy(() => import("./merchant").then((module) => ({ default: module.MerchantPage })));
const FavoritesPage = lazy(() => import("./catalog").then((module) => ({ default: module.FavoritesPage })));
const ProductPage = lazy(() => import("./catalog").then((module) => ({ default: module.ProductPage })));
const SearchPage = lazy(() => import("./catalog").then((module) => ({ default: module.SearchPage })));
const ShopPage = lazy(() => import("./catalog").then((module) => ({ default: module.ShopPage })));
const ThemeSettings = lazy(() => import("./theme/settings").then((module) => ({ default: module.ThemeSettings })));

function CategoryIcon({ category }: { category: Category }) {
    return <Icon name={category} size={32} />;
}

function Shell() {
    const location = useLocation();
    const locale = localeFromPath(location.pathname);
    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);
    useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [location.pathname]);
    return <LocaleContext.Provider value={locale}><ShellContent /></LocaleContext.Provider>;
}

function ShellContent() {
    const { t, locale, path } = useLocale();
    const location = useLocation();
    const navigate = useNavigate();
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [appearanceLoaded, setAppearanceLoaded] = useState(false);
    function switchLanguage(next: string) {
        const parts = location.pathname.split("/"); parts[1] = next;
        return `${parts.join("/")}${location.search}`;
    }
    const navigation = <>
        <NavLink to={path("/search")}><Icon name="search" /><span>{t.browse}</span></NavLink>
        <NavLink to={path("/favorites")}><Icon name="favorite" /><span>{t.favorites}</span></NavLink>
        <NavLink to={path("/merchant")}><Icon name="storefront" /><span>{t.merchant}</span></NavLink>
    </>;
    return <>
        <a className="skip-link" href="#main-content">{t.content}</a>
        <header className="site-header">
            <div className="header-inner">
                <Link className="brand" to={path()} aria-label={t.store}>
                    <img src="/favicon.svg" alt="" width="40" height="40" />
                    <span>VRCLearn<span className="brand-suffix">Store</span></span>
                </Link>
                <nav className="main-nav" aria-label={t.store}>{navigation}</nav>
                <div className="header-actions">
                    <MenuButton label={t.language} icon="translate" items={[
                        { value: "en", label: "English", selected: locale === "en" },
                        { value: "zh-CN", label: "简体中文", selected: locale === "zh-CN" },
                        { value: "ja", label: "日本語", selected: locale === "ja" }
                    ]} onSelect={(next) => navigate(switchLanguage(next))} />
                    <IconButton variant="tonal" icon="palette" label={t.theme} aria-haspopup="dialog" aria-expanded={appearanceOpen} onClick={() => { setAppearanceLoaded(true); setAppearanceOpen(true); }} />
                    <IconButton variant="tonal" icon="person" label={t.account} href={path("/account")} />
                </div>
            </div>
            <nav className="mobile-nav" aria-label={t.browse}>{navigation}</nav>
        </header>
        <main id="main-content" className="page-container"><Suspense fallback={<Busy />}><Outlet /></Suspense></main>
        <footer className="site-footer">
            <div className="footer-main">
                <div><Link className="footer-brand" to={path()}>VRCLearn Store</Link><p>{t.community}</p></div>
                <nav aria-label={t.details}>
                    <Link to={path("/terms")}>{t.terms}</Link><Link to={path("/privacy")}>{t.privacy}</Link>
                    <Link to={path("/security")}>{t.security}</Link><Link to={path("/maintenance")}>{t.maintenance}</Link>
                </nav>
            </div>
            <p className="footer-note">{t.outboundNote}</p>
        </footer>
        {appearanceLoaded && <Suspense fallback={null}><ThemeSettings open={appearanceOpen} onClose={() => setAppearanceOpen(false)} locale={locale} /></Suspense>}
    </>;
}

function HomePage() {
    const { t, path } = useLocale();
    return <>
        <section className="hero">
            <div className="hero-copy">
                <p className="eyebrow">VRChat · VRCLearn Store</p>
                <h1>{t.tagline}</h1><p>{t.intro}</p>
                <LinkButton href={path("/search")} icon="search">{t.browse}</LinkButton>
            </div>
            <div className="hero-art" aria-hidden="true">
                <div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" />
                <div className="art-tile tile-avatar"><CategoryIcon category="avatars" /><span>{t.avatars}</span></div>
                <div className="art-tile tile-world"><CategoryIcon category="worlds" /><span>{t.worlds}</span></div>
                <div className="art-tile tile-clothing"><CategoryIcon category="clothing" /><span>{t.clothing}</span></div>
                <div className="art-caption">VRCLearn Store</div>
            </div>
        </section>
        <section className="home-categories">
            <div className="section-heading"><div><p className="eyebrow">{t.featuredHeading}</p><h2>{t.categories}</h2></div><LinkButton href={path("/search")} variant="text" icon="arrow_forward">{t.all}</LinkButton></div>
            <div className="category-grid">{CATEGORIES.map((category) =>
                <Card key={category}><Link className="category-card" to={path(`/search?category=${category}`)}>
                    <InteractionState /><div className="category-icon"><CategoryIcon category={category} /></div>
                    <h3>{t[category]}</h3><Icon name="arrow_forward" size={20} className="category-arrow" />
                </Link></Card>
            )}</div>
        </section>
        <Card className="community-panel"><Icon name="storefront" size={48} /><div><p className="eyebrow">VRCLearn</p><h2>{t.discover}</h2><p>{t.communityText}</p></div><LinkButton href={path("/merchant")} variant="tonal" icon="storefront">{t.merchant}</LinkButton></Card>
    </>;
}

function InformationPage({ kind }: { kind: "privacy" | "terms" | "security" | "maintenance" }) {
    const { t, path } = useLocale();
    const text = kind === "privacy" ? t.privacyText : kind === "terms" ? t.termsText : kind === "security" ? t.securityText : t.maintenanceText;
    return <Card className="information-page panel"><p className="eyebrow">VRCLearn Store</p><h1>{t[kind]}</h1><p>{text}</p><Link to={path()}>{t.returnHome} →</Link></Card>;
}

function NotFound() {
    const { t, path } = useLocale();
    return <Card className="information-page panel"><p className="eyebrow">404</p><h1>{t.notFound}</h1><Link to={path()}>{t.returnHome} →</Link></Card>;
}

const host = document.getElementById("root") ?? document.getElementById("detail-root");
if (host) createRoot(host).render(<ThemeProvider><BrowserRouter><Routes><Route element={<Shell />}><Route path="/" element={<Navigate to="/en" replace />} /><Route path="/:locale" element={<HomePage />} /><Route path="/:locale/search" element={<SearchPage />} /><Route path="/:locale/products/:id" element={<ProductPage />} /><Route path="/:locale/shops/:id" element={<ShopPage />} /><Route path="/:locale/favorites" element={<FavoritesPage />} /><Route path="/:locale/account" element={<AccountPage />} /><Route path="/:locale/reset-password" element={<ResetPasswordPage />} /><Route path="/:locale/merchant" element={<MerchantPage />} /><Route path="/:locale/admin" element={<AdminPage />} />{(["privacy", "terms", "security", "maintenance"] as const).map((kind) => <Route key={kind} path={`/:locale/${kind}`} element={<InformationPage kind={kind} />} />)}<Route path="*" element={<NotFound />} /></Route></Routes></BrowserRouter></ThemeProvider>);
