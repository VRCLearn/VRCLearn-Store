CREATE TABLE product_comments (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    user_id TEXT NOT NULL,
    region TEXT NOT NULL CHECK (region IN ('cn', 'intl')),
    author_name TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) <= 2000),
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((deleted = 0 AND length(body) > 0) OR (deleted = 1 AND body = '')),
    UNIQUE (product_id, user_id, region)
);
CREATE INDEX product_comments_public ON product_comments(product_id, region, hidden, deleted, created_at DESC, id DESC);
CREATE TABLE comment_reports (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    comment_id TEXT NOT NULL REFERENCES product_comments(id),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    resolution TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (user_id, comment_id)
);
CREATE INDEX comment_reports_queue ON comment_reports(status, created_at);
