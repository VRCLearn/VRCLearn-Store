CREATE TABLE redemption_codes (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    shop_id TEXT NOT NULL REFERENCES shops(id),
    code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
    delivery_content TEXT NOT NULL CHECK (length(delivery_content) BETWEEN 1 AND 4000),
    imported_at TEXT NOT NULL,
    redeemed_by TEXT,
    redeemed_at TEXT,
    redeemed_region TEXT CHECK (redeemed_region IN ('cn', 'intl')),
    redeemed_title TEXT,
    CHECK ((redeemed_by IS NULL AND redeemed_at IS NULL AND redeemed_region IS NULL AND redeemed_title IS NULL)
        OR (redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL AND redeemed_region IS NOT NULL AND redeemed_title IS NOT NULL)),
    UNIQUE (product_id, code_hash)
);
CREATE INDEX redemption_codes_product_status ON redemption_codes(product_id, redeemed_by);
CREATE INDEX redemption_codes_shop ON redemption_codes(shop_id);
CREATE INDEX redemption_codes_user_region ON redemption_codes(redeemed_by, redeemed_region, redeemed_at DESC, id DESC);
