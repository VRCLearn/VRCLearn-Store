import { readFileSync } from "node:fs";
import { type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteD1 } from "./helpers";
// @ts-ignore Native Node release adapter.
import { createReleaseIO } from "../scripts/release-cloudflare.mjs";
// @ts-ignore Native Node migration policy.
import { migrationPlan } from "../scripts/migration-policy.mjs";

function fixture() {
    const control = sqliteD1(), business = sqliteD1(); control.database.exec(readFileSync("deployment/release-control.sql", "utf8"));
    const api = async (path: string, { body }: { body: { batch: { sql: string; params: SQLInputValue[] }[] } }) => { const db = path.includes("/database/control/") ? control : business; return db.binding.batch(body.batch.map(({ sql, params }) => db.binding.prepare(sql).bind(...params))); };
    const makeIO = () => createReleaseIO({ environment: "test", accountId: "test-account", releaseDatabaseId: "control", d1DatabaseId: "business" }, {}, { api });
    return { control, business, makeIO, close() { control.database.close(); business.database.close(); } };
}
describe("new release-control database", () => {
    it("admits one publisher, never steals an expired lease and does not let an old job unlock a newer one", async () => {
        const test = fixture();
        try {
            const first = test.makeIO(), second = test.makeIO();
            expect(await Promise.all([first.acquireLease("one", "a".repeat(40), Date.now() + 60000), second.acquireLease("two", "b".repeat(40), Date.now() + 60000)])).toEqual([true, false]);
            await first.failLease("one", { stage: "app", uncertain: true, supportVersionId: "support" });
            expect(await second.acquireLease("two", "b".repeat(40), Date.now() + 60000)).toBe(false);
            test.control.database.prepare("UPDATE release_leases SET lease_id='two',release_sha=?,outcome='running' WHERE environment='test'").run("b".repeat(40));
            await first.failLease("one", { stage: "app", uncertain: false });
            await expect(first.completeLease("one", "a".repeat(40), { appVersionId: "old", supportVersionId: "old" })).rejects.toThrow("LEASE_LOST");
            expect(await second.assertLease("two", "b".repeat(40))).toBe(true);
        } finally { test.close(); }
    });
    it("initializes the fixed consolidated schema only when the business database is empty", async () => {
        const test = fixture();
        try {
            const io = test.makeIO(); expect(await io.appliedMigrations()).toEqual([]);
            const plan = migrationPlan([{ name: "0001_initial.sql", sql: readFileSync("migrations/0001_initial.sql", "utf8") }], []);
            await io.applyMigration(plan[0]); await io.recordMigration(plan[0]);
            expect(await io.appliedMigrations()).toEqual(["0001_initial.sql"]);
            expect(test.business.database.prepare("SELECT count(*) AS count FROM auth_user").get()?.count).toBe(0);
            expect(test.business.database.prepare("SELECT count(*) AS count FROM products").get()?.count).toBe(0);
            expect(test.business.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'").get()?.count).toBeGreaterThan(0);
            expect(Object.keys(await io.migrationChecksums())).toEqual(["0001_initial.sql"]);
        } finally { test.close(); }
    });
    it("does not bootstrap over untracked existing tables", async () => {
        const test = fixture();
        try { test.business.database.exec("CREATE TABLE existing(id TEXT)"); await expect(test.makeIO().appliedMigrations()).rejects.toThrow("MIGRATION_DATABASE_NOT_EMPTY"); } finally { test.close(); }
    });
    it("does not treat an untracked view as an empty schema", async () => {
        const test = fixture();
        try { test.business.database.exec("CREATE VIEW leftover AS SELECT 'old' AS value"); await expect(test.makeIO().appliedMigrations()).rejects.toThrow("MIGRATION_DATABASE_NOT_EMPTY"); } finally { test.close(); }
    });
    it("rolls back an additive schema change with a failed migration ledger insert", async () => {
        const test = fixture();
        try {
            test.business.database.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL); INSERT INTO d1_migrations(name) VALUES('0002_widgets.sql');");
            await expect(test.makeIO().applyMigration({ name: "0002_widgets.sql", statements: ["CREATE TABLE widgets(id TEXT);"] })).rejects.toThrow();
            expect(test.business.database.prepare("SELECT name FROM sqlite_master WHERE name='widgets'").get()).toBeUndefined();
        } finally { test.close(); }
    });
});
