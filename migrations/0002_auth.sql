CREATE TABLE auth_user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    twoFactorEnabled INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE auth_two_factor (
    id TEXT PRIMARY KEY NOT NULL,
    secret TEXT NOT NULL,
    backupCodes TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    verified INTEGER DEFAULT 1,
    failedVerificationCount INTEGER DEFAULT 0,
    lockedUntil INTEGER
);
CREATE INDEX auth_two_factor_user_idx ON auth_two_factor(userId);
CREATE INDEX auth_two_factor_secret_idx ON auth_two_factor(secret);
CREATE TABLE auth_mfa_sessions (
    session_id TEXT PRIMARY KEY REFERENCES auth_session(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
