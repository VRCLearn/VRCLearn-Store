PRAGMA foreign_keys = ON;

CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0, 1))
);
CREATE TABLE shops (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL UNIQUE,
    current_revision_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE shop_revisions (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    review_reason TEXT NOT NULL DEFAULT '',
    decision_token TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX shop_revisions_shop ON shop_revisions(shop_id, created_at DESC);
CREATE TABLE regional_permissions (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    region TEXT NOT NULL CHECK (region IN ('cn', 'intl')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    reason TEXT NOT NULL,
    review_reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (shop_id, region)
);
CREATE INDEX permissions_queue ON regional_permissions(status, updated_at);
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    current_revision_id TEXT,
    latest_revision_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX products_shop ON products(shop_id, updated_at DESC, id);
CREATE TABLE product_revisions (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'rejected', 'published', 'withdrawn')),
    review_reason TEXT NOT NULL DEFAULT '',
    submission_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX revisions_product ON product_revisions(product_id, created_at DESC);
CREATE INDEX revisions_queue ON product_revisions(status, created_at);
CREATE TABLE publication_requests (
    revision_id TEXT NOT NULL REFERENCES product_revisions(id),
    region TEXT NOT NULL CHECK (region IN ('cn', 'intl')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (revision_id, region)
);
CREATE TABLE publications (
    product_id TEXT NOT NULL REFERENCES products(id),
    region TEXT NOT NULL CHECK (region IN ('cn', 'intl')),
    revision_id TEXT NOT NULL REFERENCES product_revisions(id),
    media_token TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    category TEXT NOT NULL,
    pricing TEXT NOT NULL,
    currency TEXT,
    price REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (product_id, region)
);
CREATE INDEX publications_catalog ON publications(region, active, updated_at DESC, product_id DESC);
CREATE INDEX publications_category ON publications(region, active, category, updated_at DESC, product_id DESC);
CREATE INDEX publications_pricing ON publications(region, active, pricing, updated_at DESC, product_id DESC);
CREATE INDEX publications_price_asc ON publications(region, active, currency, price ASC, product_id DESC);
CREATE INDEX publications_price_desc ON publications(region, active, currency, price DESC, product_id DESC);
CREATE TABLE media (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL REFERENCES shops(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    private_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 2097152),
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    retiring INTEGER NOT NULL DEFAULT 0 CHECK (retiring IN (0, 1)),
    created_at TEXT NOT NULL
);
CREATE INDEX media_product ON media(product_id, created_at);
CREATE TABLE public_media (
    product_id TEXT NOT NULL REFERENCES products(id),
    region TEXT NOT NULL CHECK (region IN ('cn', 'intl')),
    revision_id TEXT NOT NULL REFERENCES product_revisions(id),
    media_id TEXT NOT NULL REFERENCES media(id),
    media_token TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    PRIMARY KEY (product_id, region, revision_id, media_token, media_id)
);
CREATE TABLE favorites (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
);
CREATE INDEX favorites_page ON favorites(user_id, created_at DESC, product_id DESC);
CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    resolution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (user_id, product_id)
);
CREATE INDEX reports_queue ON reports(status, created_at);
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    region TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX audit_time ON audit_log(created_at);
CREATE VIRTUAL TABLE product_search USING fts5(product_id UNINDEXED, tokens, tokenize='unicode61');
CREATE TABLE product_facets (
    product_id TEXT NOT NULL REFERENCES products(id),
    kind TEXT NOT NULL CHECK (kind IN ('tag', 'model', 'platform', 'category', 'pricing', 'currency')),
    value TEXT NOT NULL,
    PRIMARY KEY (product_id, kind, value)
);
CREATE INDEX facets_lookup ON product_facets(kind, value, product_id);

CREATE TABLE media_storage_total (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    bytes INTEGER NOT NULL CHECK (bytes >= 0 AND bytes <= 8589934592)
);
INSERT INTO media_storage_total (id, bytes) VALUES (1, 0);
CREATE TABLE media_storage_objects (
    bucket TEXT NOT NULL CHECK (bucket IN ('private', 'public')),
    object_key TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size > 0 AND size <= 2097152),
    created_at TEXT NOT NULL,
    PRIMARY KEY (bucket, object_key)
);
CREATE INDEX storage_objects_age ON media_storage_objects(created_at, bucket, object_key);
CREATE TRIGGER media_storage_before_insert BEFORE INSERT ON media_storage_objects
WHEN (SELECT bytes FROM media_storage_total WHERE id = 1) + NEW.size > 8589934592
BEGIN SELECT RAISE(ABORT, 'STORAGE_QUOTA_EXCEEDED'); END;
CREATE TRIGGER media_storage_after_insert AFTER INSERT ON media_storage_objects
BEGIN UPDATE media_storage_total SET bytes = bytes + NEW.size WHERE id = 1; END;
CREATE TRIGGER media_storage_after_delete AFTER DELETE ON media_storage_objects
BEGIN UPDATE media_storage_total SET bytes = bytes - OLD.size WHERE id = 1; END;
