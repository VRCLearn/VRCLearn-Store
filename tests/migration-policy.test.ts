import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore Native Node scripts are tested directly.
import { baselineMigrations, migrationDigest, migrationPlan, migrationStatements, validateAutomaticMigration } from "../scripts/migration-policy.mjs";

const baseline = Object.keys(baselineMigrations).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") }));

describe("automatic migration boundary", () => {
    it.each([
        "CREATE TABLE widgets (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Delete; Drop');",
        "CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY) STRICT;",
        "CREATE INDEX widget_title ON widgets(title);",
        "CREATE UNIQUE INDEX widget_title ON widgets(title) WHERE title IS NOT NULL;",
        "ALTER TABLE widgets ADD COLUMN note TEXT;",
        "ALTER TABLE widgets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE widgets ADD COLUMN label TEXT NOT NULL DEFAULT 'display';",
    ])("allows an explicitly additive statement %s", (sql) => {
        expect(validateAutomaticMigration("0005_widgets.sql", sql).statements).toHaveLength(1);
    });
    it.each([
        "DROP TABLE widgets;", "DELETE FROM widgets;", "UPDATE widgets SET title='new';", "INSERT INTO widgets VALUES('x');",
        "ALTER TABLE widgets DROP COLUMN title;", "ALTER TABLE widgets ADD title TEXT NOT NULL;",
        "ALTER TABLE widgets ADD title TEXT NOT NULL DEFAULT NULL;", "CREATE TABLE copy AS SELECT * FROM widgets;",
        "CREATE TRIGGER changed AFTER INSERT ON widgets BEGIN DELETE FROM widgets; END;",
        "PRAGMA writable_schema=1;", "ATTACH DATABASE 'other' AS other;", "VACUUM;",
        "ALTER TABLE widgets ADD extra TEXT CHECK(length(extra)>0);", "ALTER TABLE widgets ADD x TEXT REFERENCES other(id);",
        "ALTER TABLE widgets ADD x TEXT DEFAULT (random());", "CREATE VIEW copies AS SELECT * FROM widgets;",
        "CREATE UNIQUE TABLE widgets(id TEXT);",
    ])("blocks destructive or unclassified SQL %s", (sql) => {
        expect(() => validateAutomaticMigration("0005_widgets.sql", sql)).toThrow();
    });
    it("lexes quoted semicolons and comments without accepting a second destructive statement", () => {
        const statements = migrationStatements("-- drop is a comment\nCREATE TABLE x(label TEXT DEFAULT 'a;''b'); /* comment; */ CREATE INDEX x_label ON x(label);");
        expect(statements).toHaveLength(2);
        expect(() => validateAutomaticMigration("0005_x.sql", statements[0].sql + "DELETE FROM x;")).toThrow("MIGRATION_REQUIRES_REVIEW");
        expect(() => migrationStatements("CREATE TABLE x(a TEXT DEFAULT 'unclosed);")).toThrow("UNCLOSED");
    });
    it("requires the manual bootstrap and rejects edits to applied history", () => {
        const names = baseline.map((file) => file.name);
        expect(() => migrationPlan(baseline, names.slice(0, 3))).toThrow("BOOTSTRAP");
        expect(() => migrationPlan(baseline.map((file, index) => index ? file : { ...file, sql: file.sql + "\n-- changed" }), names)).toThrow("BASELINE_CHANGED");
        expect(migrationPlan([...baseline, { name: "0005_widgets.sql", sql: "CREATE TABLE widgets(id TEXT);" }], names)).toHaveLength(1);
        expect(migrationDigest("a\r\nb")).toBe(migrationDigest("a\nb"));
    });
    it("requires recorded checksums for every automatically applied migration", () => {
        const file = { name: "0005_widgets.sql", sql: "CREATE TABLE widgets(id TEXT);" };
        const files = [...baseline, file];
        const names = files.map((entry) => entry.name);
        expect(() => migrationPlan(files, names)).toThrow("HISTORY_CHANGED");
        expect(migrationPlan(files, names, { [file.name]: migrationDigest(file.sql) })).toEqual([]);
    });
});
