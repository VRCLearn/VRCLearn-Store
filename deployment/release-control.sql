-- Control-plane metadata only. Never bind this database to either business runtime.
CREATE TABLE release_leases (
    environment TEXT PRIMARY KEY CHECK (environment IN ('production', 'test')),
    lease_id TEXT,
    release_sha TEXT,
    phase TEXT NOT NULL DEFAULT 'idle',
    expires_at INTEGER,
    pages_deployment_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'idle',
    updated_at INTEGER NOT NULL
);
INSERT INTO release_leases(environment, updated_at) VALUES ('production', 0), ('test', 0);
CREATE TABLE release_migration_checksums (
    environment TEXT NOT NULL CHECK (environment IN ('production', 'test')),
    name TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY(environment, name)
);
