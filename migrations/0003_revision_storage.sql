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

-- Allocate all existing audit snapshots before enabling checks on new growth.
INSERT INTO revision_storage_total
SELECT 1, COUNT(*), COALESCE(SUM(length(CAST(content_json AS BLOB))), 0)
FROM (SELECT content_json FROM shop_revisions UNION ALL SELECT content_json FROM product_revisions);
INSERT INTO revision_storage_shops
SELECT s.id, COUNT(r.content_json), COALESCE(SUM(length(CAST(r.content_json AS BLOB))), 0)
FROM shops s LEFT JOIN (
    SELECT shop_id, content_json FROM shop_revisions
    UNION ALL
    SELECT p.shop_id, r.content_json FROM product_revisions r JOIN products p ON p.id = r.product_id
) r ON r.shop_id = s.id GROUP BY s.id;

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
