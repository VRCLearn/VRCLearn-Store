CREATE TABLE auth_user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);
CREATE TABLE auth_session (
    id TEXT PRIMARY KEY NOT NULL,
    expiresAt INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);
CREATE INDEX auth_session_user_idx ON auth_session(userId);
CREATE INDEX auth_session_expiry_idx ON auth_session(expiresAt);
CREATE TABLE auth_account (
    id TEXT PRIMARY KEY NOT NULL,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    password TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    UNIQUE(providerId,accountId)
);
CREATE INDEX auth_account_user_idx ON auth_account(userId);
CREATE TABLE auth_verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification(identifier);
CREATE INDEX auth_verification_expiry_idx ON auth_verification(expiresAt);

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

-- Retained JSON content only; this ledger does not measure total database size.
CREATE TABLE revision_storage_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    global_row_limit INTEGER NOT NULL CHECK (global_row_limit > 0),
    global_byte_limit INTEGER NOT NULL CHECK (global_byte_limit > 0),
    shop_row_limit INTEGER NOT NULL CHECK (shop_row_limit > 0),
    shop_byte_limit INTEGER NOT NULL CHECK (shop_byte_limit > 0)
);
INSERT INTO revision_storage_policy VALUES (1, 100000, 1073741824, 2000, 33554432);
CREATE TABLE revision_storage_total (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0)
);
CREATE TABLE revision_storage_shops (
    shop_id TEXT PRIMARY KEY REFERENCES shops(id),
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0)
);

INSERT INTO revision_storage_total VALUES (1, 0, 0);

CREATE TRIGGER revision_storage_total_limit BEFORE UPDATE ON revision_storage_total
WHEN (NEW.row_count > OLD.row_count AND NEW.row_count > (SELECT global_row_limit FROM revision_storage_policy WHERE id = 1))
    OR (NEW.content_bytes > OLD.content_bytes AND NEW.content_bytes > (SELECT global_byte_limit FROM revision_storage_policy WHERE id = 1))
BEGIN SELECT RAISE(ABORT, 'REVISION_STORAGE_QUOTA_EXCEEDED'); END;
CREATE TRIGGER revision_storage_shop_limit BEFORE UPDATE ON revision_storage_shops
WHEN (NEW.row_count > OLD.row_count AND NEW.row_count > (SELECT shop_row_limit FROM revision_storage_policy WHERE id = 1))
    OR (NEW.content_bytes > OLD.content_bytes AND NEW.content_bytes > (SELECT shop_byte_limit FROM revision_storage_policy WHERE id = 1))
BEGIN SELECT RAISE(ABORT, 'REVISION_STORAGE_QUOTA_EXCEEDED'); END;
CREATE TRIGGER revision_storage_new_shop AFTER INSERT ON shops
BEGIN INSERT INTO revision_storage_shops VALUES (NEW.id, 0, 0); END;

CREATE TRIGGER shop_revision_storage_insert AFTER INSERT ON shop_revisions
BEGIN
    UPDATE revision_storage_total SET row_count = row_count + 1, content_bytes = content_bytes + length(CAST(NEW.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops SET row_count = row_count + 1, content_bytes = content_bytes + length(CAST(NEW.content_json AS BLOB)) WHERE shop_id = NEW.shop_id;
END;
CREATE TRIGGER shop_revision_storage_update AFTER UPDATE OF shop_id, content_json ON shop_revisions
BEGIN
    UPDATE revision_storage_total SET content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) + length(CAST(NEW.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops
    SET row_count = row_count - (shop_id = OLD.shop_id) + (shop_id = NEW.shop_id),
        content_bytes = content_bytes - (shop_id = OLD.shop_id) * length(CAST(OLD.content_json AS BLOB)) + (shop_id = NEW.shop_id) * length(CAST(NEW.content_json AS BLOB))
    WHERE shop_id IN (OLD.shop_id, NEW.shop_id);
END;
CREATE TRIGGER shop_revision_storage_delete AFTER DELETE ON shop_revisions
BEGIN
    UPDATE revision_storage_total SET row_count = row_count - 1, content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops SET row_count = row_count - 1, content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) WHERE shop_id = OLD.shop_id;
END;

CREATE TRIGGER product_revision_storage_insert AFTER INSERT ON product_revisions
BEGIN
    UPDATE revision_storage_total SET row_count = row_count + 1, content_bytes = content_bytes + length(CAST(NEW.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops SET row_count = row_count + 1, content_bytes = content_bytes + length(CAST(NEW.content_json AS BLOB)) WHERE shop_id = (SELECT shop_id FROM products WHERE id = NEW.product_id);
END;
CREATE TRIGGER product_revision_storage_update AFTER UPDATE OF product_id, content_json ON product_revisions
BEGIN
    UPDATE revision_storage_total SET content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) + length(CAST(NEW.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops
    SET row_count = row_count - (shop_id = (SELECT shop_id FROM products WHERE id = OLD.product_id)) + (shop_id = (SELECT shop_id FROM products WHERE id = NEW.product_id)),
        content_bytes = content_bytes - (shop_id = (SELECT shop_id FROM products WHERE id = OLD.product_id)) * length(CAST(OLD.content_json AS BLOB)) + (shop_id = (SELECT shop_id FROM products WHERE id = NEW.product_id)) * length(CAST(NEW.content_json AS BLOB))
    WHERE shop_id IN (SELECT shop_id FROM products WHERE id IN (OLD.product_id, NEW.product_id));
END;
CREATE TRIGGER product_revision_storage_delete AFTER DELETE ON product_revisions
BEGIN
    UPDATE revision_storage_total SET row_count = row_count - 1, content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) WHERE id = 1;
    UPDATE revision_storage_shops SET row_count = row_count - 1, content_bytes = content_bytes - length(CAST(OLD.content_json AS BLOB)) WHERE shop_id = (SELECT shop_id FROM products WHERE id = OLD.product_id);
END;
CREATE TRIGGER product_revision_storage_move AFTER UPDATE OF shop_id ON products
WHEN NEW.shop_id != OLD.shop_id
BEGIN
    UPDATE revision_storage_shops
    SET row_count = row_count + ((shop_id = NEW.shop_id) - (shop_id = OLD.shop_id)) * (SELECT COUNT(*) FROM product_revisions WHERE product_id = NEW.id),
        content_bytes = content_bytes + ((shop_id = NEW.shop_id) - (shop_id = OLD.shop_id)) * (SELECT COALESCE(SUM(length(CAST(content_json AS BLOB))), 0) FROM product_revisions WHERE product_id = NEW.id)
    WHERE shop_id IN (OLD.shop_id, NEW.shop_id);
END;

CREATE INDEX publications_revision ON publications(revision_id);
CREATE INDEX public_media_revision ON public_media(revision_id);
