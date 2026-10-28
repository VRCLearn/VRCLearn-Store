-- Build-time release coordination only; never bind this database to a runtime.
CREATE TABLE release_leases (
    environment TEXT PRIMARY KEY CHECK (environment IN ('production', 'test')),
    lease_id TEXT,
    release_sha TEXT,
    phase TEXT NOT NULL DEFAULT 'idle',
    expires_at INTEGER,
    app_version_id TEXT,
    support_version_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'idle',
    updated_at INTEGER NOT NULL
);
INSERT INTO release_leases(environment, updated_at) VALUES ('test', 0);
CREATE TABLE release_migration_checksums (
    environment TEXT NOT NULL CHECK (environment IN ('production', 'test')),
    name TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY(environment, name)
);
