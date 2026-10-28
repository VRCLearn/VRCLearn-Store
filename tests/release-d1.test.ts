import { readFileSync } from "node:fs";
import { type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteD1 } from "./helpers";
// @ts-ignore Native Node scripts are tested directly.
import { createReleaseIO } from "../scripts/release-cloudflare.mjs";

function controlFixture() {
    const control = sqliteD1();
    const business = sqliteD1();
    control.database.exec(readFileSync("deployment/release-control.sql", "utf8"));
    business.database.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);");
    const api = async (path: string, { body }: { body: { batch: { sql: string; params: SQLInputValue[] }[] } }) => {
        const db = path.includes("/database/control/") ? control : business;
        return db.binding.batch(body.batch.map(({ sql, params }) => db.binding.prepare(sql).bind(...params)));
    };
    const makeIO = (environment: "production" | "test") => createReleaseIO({ environment, accountId: "test-account", releaseDatabaseId: "control", d1DatabaseId: "business" }, {}, { api });
    return { control, business, makeIO, close() { control.database.close(); business.database.close(); } };
}

describe("release-control D1 coordination", () => {
    it("admits one concurrent publisher per environment while allowing the other environment independently", async () => {
        const fixture = controlFixture();
        try {
            const first = fixture.makeIO("test"), second = fixture.makeIO("test"), production = fixture.makeIO("production");
            expect(await Promise.all([first.acquireLease("one", "a".repeat(40), Date.now() + 60000), second.acquireLease("two", "b".repeat(40), Date.now() + 60000)])).toEqual([true, false]);
            expect(await production.acquireLease("three", "c".repeat(40), Date.now() + 60000)).toBe(true);
            await expect(second.mark("two", { stage: "worker", sha: "b".repeat(40), expiresAt: Date.now() + 60000 })).rejects.toThrow("LEASE_LOST");
            expect(await first.assertLease("one", "a".repeat(40))).toBe(true);
        } finally { fixture.close(); }
    });
    it("never steals an expired or unconfirmed lease, and an old job cannot release a newer job's lock", async () => {
        const fixture = controlFixture();
        try {
            const io = fixture.makeIO("test");
            await io.acquireLease("old", "a".repeat(40), Date.now() - 1);
            await io.failLease("old", { stage: "pages", uncertain: true, pagesDeploymentId: "unknown-page" });
            expect(await io.acquireLease("new", "b".repeat(40), Date.now() + 60000)).toBe(false);
            fixture.control.database.prepare("UPDATE release_leases SET lease_id='new',release_sha=?,outcome='running',expires_at=? WHERE environment='test'").run("b".repeat(40), Date.now() + 60000);
            await io.failLease("old", { stage: "pages", uncertain: false });
            await expect(io.completeLease("old", "a".repeat(40), "old-page")).rejects.toThrow("LEASE_LOST");
            expect(await io.assertLease("new", "b".repeat(40))).toBe(true);
        } finally { fixture.close(); }
    });
    it("rolls back schema changes together with a failed migration-ledger insert", async () => {
        const fixture = controlFixture();
        try {
            fixture.business.database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run("0005_widgets.sql");
            await expect(fixture.makeIO("test").applyMigration({ name: "0005_widgets.sql", statements: ["CREATE TABLE widgets(id TEXT);"] })).rejects.toThrow();
            expect(fixture.business.database.prepare("SELECT name FROM sqlite_master WHERE name='widgets'").get()).toBeUndefined();
            expect(fixture.business.database.prepare("SELECT count(*) AS count FROM d1_migrations").get()?.count).toBe(1);
        } finally { fixture.close(); }
    });
});
