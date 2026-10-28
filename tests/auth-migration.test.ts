import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

function database() {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
    return database;
}

describe("initial application schema", () => {
    it("initializes a fresh database with authentication, search and bounded storage without retired MFA", () => {
        const sql = database();
        try {
            expect(readdirSync("migrations").filter((name) => name.endsWith(".sql"))).toEqual(["0001_initial.sql"]);
            expect(sql.prepare("PRAGMA table_info(auth_user)").all().map((column) => column.name)).not.toContain("twoFactorEnabled");
            expect(sql.prepare("SELECT name FROM sqlite_master WHERE name IN ('auth_two_factor','auth_mfa_sessions')").all()).toEqual([]);
            expect(sql.prepare("SELECT bytes FROM media_storage_total WHERE id=1").get()?.bytes).toBe(0);
            expect(sql.prepare("SELECT row_count,content_bytes FROM revision_storage_total WHERE id=1").get()).toEqual({ row_count: 0, content_bytes: 0 });
            expect(sql.prepare("SELECT COUNT(*) AS n FROM product_search").get()?.n).toBe(0);
            expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(sql.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally { sql.close(); }
    });

    it("keeps email ownership unverified, email identifiers unique and dependent credentials scoped to their user", () => {
        const sql = database();
        try {
            sql.prepare("INSERT INTO auth_user(id,name,email,createdAt,updatedAt) VALUES('owner','Nickname','owner@example.com',1,1)").run();
            expect(sql.prepare("SELECT emailVerified FROM auth_user WHERE id='owner'").get()?.emailVerified).toBe(0);
            expect(() => sql.prepare("INSERT INTO auth_user(id,name,email,createdAt,updatedAt) VALUES('duplicate','Other','owner@example.com',1,1)").run()).toThrow(/UNIQUE/);
            sql.prepare("INSERT INTO auth_user(id,name,email,createdAt,updatedAt) VALUES('other','Nickname','other@example.com',1,1)").run();
            sql.prepare("INSERT INTO auth_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('credential','owner','credential','owner','hash',1,1)").run();
            sql.prepare("INSERT INTO auth_session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES('session','token','owner',9999999999999,1,1)").run();
            expect(() => sql.prepare("INSERT INTO auth_session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES('bad','other-token','missing',9999999999999,1,1)").run()).toThrow(/FOREIGN KEY/);
            sql.prepare("DELETE FROM auth_user WHERE id='owner'").run();
            expect(sql.prepare("SELECT COUNT(*) AS n FROM auth_account").get()?.n).toBe(0);
            expect(sql.prepare("SELECT COUNT(*) AS n FROM auth_session").get()?.n).toBe(0);
            expect(sql.prepare("SELECT id FROM auth_user").get()?.id).toBe("other");
        } finally { sql.close(); }
    });
});
