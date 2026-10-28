import { useEffect, useState } from "react";
import type { Product } from "../shared/contracts";
import { api } from "./api";
import { Card, LinkButton } from "./material";
import { ActionButton, Busy, ProductCard, useLocale } from "./ui";

export function HomeRecommendations() {
    const { t, path } = useLocale();
    const [items, setItems] = useState<Product[]>();
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10000);
        let active = true;
        setFailed(false);
        setItems(undefined);
        void api<{ items: Product[] }>("/recommendations", { signal: controller.signal })
            .then((result) => { if (active) setItems(result.items); })
            .catch(() => { if (active) setFailed(true); })
            .finally(() => window.clearTimeout(timeout));
        return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
    }, [attempt]);
    return <section className="home-recommendations" aria-labelledby="home-recommendations-heading">
        <div className="section-heading"><h2 id="home-recommendations-heading">{t.homeRecommendations}</h2><LinkButton href={path("/search")} variant="text" icon="arrow_forward">{t.browse}</LinkButton></div>
        {failed ? <Card className="panel" role="alert"><p>{t.catalogUnavailable}</p><ActionButton busy={false} variant="outlined" onClick={() => setAttempt((value) => value + 1)}>{t.retryLoad}</ActionButton></Card>
            : !items ? <Busy /> : items.length ? <div className="product-grid">{items.map((product) => <ProductCard key={product.id} product={product} />)}</div>
                : <Card className="panel"><p>{t.recommendationsEmpty}</p><LinkButton href={path("/search")} variant="text">{t.browse}</LinkButton></Card>}
    </section>;
}
