-- Remove retired authenticator challenges and trusted-device records while
-- preserving email verification, password reset, accounts and active sessions.
DELETE FROM auth_verification
WHERE identifier GLOB '2fa-*' OR identifier GLOB 'trust-device-*';
DROP TABLE auth_mfa_sessions;
DROP TABLE auth_two_factor;
ALTER TABLE auth_user DROP COLUMN twoFactorEnabled;
