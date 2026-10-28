import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retired MFA schema migration", () => {
    it("initializes a new database without retired authentication fields or tables", () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec("PRAGMA foreign_keys = ON");
            for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
                database.exec(readFileSync(`migrations/${name}`, "utf8"));
            }
            expect(database.prepare("PRAGMA table_info(auth_user)").all().map((column) => column.name)).not.toContain("twoFactorEnabled");
            expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('auth_two_factor','auth_mfa_sessions')").all()).toEqual([]);
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally { database.close(); }
    });

    it("removes enrolled secrets and challenges while preserving accounts, password hashes, sessions and email flows", () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec("PRAGMA foreign_keys = ON");
            for (const name of ["0001_business.sql", "0002_auth.sql", "0003_revision_storage.sql"]) database.exec(readFileSync(`migrations/${name}`, "utf8"));
            database.exec(`
                INSERT INTO auth_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
                VALUES('owner','Owner','owner@example.com',1,1,1,1);
                INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt)
                VALUES('credential','owner','credential','owner','existing-password-hash',1,1);
                INSERT INTO auth_session(id,expiresAt,token,createdAt,updatedAt,userId)
                VALUES('session',9999999999999,'existing-session-token',1,1,'owner');
                INSERT INTO user_profiles(user_id,role,banned) VALUES('owner','admin',0);
                INSERT INTO auth_two_factor(id,secret,backupCodes,userId) VALUES('factor','retired-secret','retired-codes','owner');
                INSERT INTO auth_mfa_sessions(session_id,user_id,expires_at) VALUES('session','owner',9999999999999);
            `);
            const insert = database.prepare("INSERT INTO auth_verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,9999999999999,1,1)");
            for (const identifier of ["2fa-challenge", "2fa-attempts-2fa-challenge", "trust-device-device", "email-verification", "reset-password:reset-token"]) insert.run(identifier, identifier, "owner");
            const user = database.prepare("SELECT id,name,email,emailVerified,createdAt,updatedAt FROM auth_user").get();
            const credential = database.prepare("SELECT * FROM auth_account").get();
            const session = database.prepare("SELECT * FROM auth_session").get();

            database.exec(readFileSync("migrations/0004_remove_mfa.sql", "utf8"));

            expect(database.prepare("SELECT * FROM auth_user").get()).toEqual({ ...user, image: null });
            expect(database.prepare("SELECT * FROM auth_account").get()).toEqual(credential);
            expect(database.prepare("SELECT * FROM auth_session").get()).toEqual(session);
            expect(database.prepare("SELECT role,banned FROM user_profiles WHERE user_id='owner'").get()).toEqual({ role: "admin", banned: 0 });
            expect(database.prepare("SELECT identifier FROM auth_verification ORDER BY identifier").all()).toEqual([{ identifier: "email-verification" }, { identifier: "reset-password:reset-token" }]);
            expect(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('auth_two_factor','auth_mfa_sessions')").all()).toEqual([]);
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally { database.close(); }
    });
});
