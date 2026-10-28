import { useRef } from "react";
import { Card, Icon, IconButton, LinkButton } from "./material";
import { useLocale } from "./ui";
import "./home-banners.css";

const categories = ["avatars", "worlds", "clothing"] as const;

export function HomeBanners() {
    const { t, path } = useLocale();
    const track = useRef<HTMLDivElement>(null);
    function scroll(direction: -1 | 1) {
        const element = track.current;
        if (!element) return;
        element.scrollBy({ left: direction * element.clientWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    return <section className="home-banners" aria-label={t.homeBanners}>
        <div className="section-heading"><h2>{t.homeBanners}</h2><div className="button-row">
            <IconButton variant="outlined" icon="arrow_back" label={t.back} onClick={() => scroll(-1)} />
            <IconButton variant="outlined" icon="arrow_forward" label={t.loadMore} onClick={() => scroll(1)} />
        </div></div>
        <div className="home-banner-track" ref={track}>
            {categories.map((category) => <Card className="home-banner" key={category}>
                <div><p className="eyebrow">{t.discover}</p><h3>{t[category]}</h3><LinkButton href={path(`/search?category=${category}`)} variant="tonal" icon="arrow_forward">{t.browse}</LinkButton></div>
                <Icon className="home-banner-symbol" name={category} size={96} />
            </Card>)}
        </div>
    </section>;
}
