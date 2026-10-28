import { createHash } from "node:crypto";

export const baselineMigrations = Object.freeze({
    "0001_initial.sql": "577723ee1d4e2095ef5c8820c0f97ca5020cc7c872b91979b07cc66633117f49",
});

export function migrationDigest(sql) {
    return createHash("sha256").update(sql.replace(/\r\n?/g, "\n")).digest("hex");
}

// Deliberately narrower than SQLite: an unknown construct requires review.
// Quotes and comments are lexed before classifying statements, so a semicolon or
// a destructive keyword inside a string cannot change the policy decision.
export function migrationStatements(sql) {
    if (typeof sql !== "string" || Buffer.byteLength(sql) > 262144 || sql.includes("\0")) throw new Error("MIGRATION_INPUT_REJECTED");
    const statements = [];
    let tokens = [], start = 0, index = 0, triggerDepth = 0;
    const flush = (end) => { if (tokens.length) statements.push({ sql: sql.slice(start, end).trim(), tokens }); tokens = []; triggerDepth = 0; start = end; };
    while (index < sql.length) {
        const char = sql[index];
        if (/\s/.test(char)) { index++; continue; }
        if (sql.startsWith("--", index)) { index = sql.indexOf("\n", index + 2); if (index < 0) index = sql.length; continue; }
        if (sql.startsWith("/*", index)) { const end = sql.indexOf("*/", index + 2); if (end < 0) throw new Error("MIGRATION_UNCLOSED_COMMENT"); index = end + 2; continue; }
        if (char === ";") { index++; if (!triggerDepth) flush(index); continue; }
        if (["'", '"', "`", "["].includes(char)) {
            const close = char === "[" ? "]" : char;
            const begin = index++;
            let closed = false;
            while (index < sql.length) {
                if (sql[index++] !== close) continue;
                if (char !== "[" && sql[index] === close) { index++; continue; }
                closed = true; break;
            }
            if (!closed) throw new Error("MIGRATION_UNCLOSED_QUOTE");
            tokens.push({ value: sql.slice(begin, index), kind: char === "'" ? "literal" : "identifier" });
            continue;
        }
        const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(index));
        if (word) {
            const value = word[0].toUpperCase();
            if (tokens[0]?.value === "CREATE" && tokens.some((token) => token.value === "TRIGGER" && token.kind === "word")) {
                if (["BEGIN", "CASE"].includes(value)) triggerDepth++;
                if (value === "END") triggerDepth--;
                if (triggerDepth < 0) throw new Error("MIGRATION_TRIGGER_INVALID");
            }
            tokens.push({ value, kind: "word" }); index += word[0].length; continue;
        }
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(index));
        if (number) { tokens.push({ value: number[0], kind: "number" }); index += number[0].length; continue; }
        tokens.push({ value: char, kind: "symbol" }); index++;
    }
    if (triggerDepth) throw new Error("MIGRATION_TRIGGER_UNCLOSED");
    flush(index);
    if (!statements.length) throw new Error("MIGRATION_EMPTY");
    return statements;
}

const identifier = (token) => token && ["word", "identifier"].includes(token.kind);
function classify({ tokens }) {
    const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
    const values = tokens.map((token) => token.value);
    if (words.some((word) => ["SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "TRIGGER", "ATTACH", "DETACH", "PRAGMA", "REPLACE", "RENAME", "VACUUM"].includes(word))) return false;
    let index = 0;
    if (values[index++] === "CREATE") {
        const unique = values[index] === "UNIQUE";
        if (unique) index++;
        const kind = values[index++];
        if (!["TABLE", "INDEX"].includes(kind) || unique && kind !== "INDEX") return false;
        if (values.slice(index, index + 3).join(" ") === "IF NOT EXISTS") index += 3;
        if (!identifier(tokens[index++])) return false;
        if (kind === "INDEX") {
            if (values[index++] !== "ON" || !identifier(tokens[index++])) return false;
        }
        if (values[index] !== "(") return false;
        let depth = 0, closed = -1;
        for (; index < values.length; index++) {
            if (values[index] === "(") depth++;
            if (values[index] === ")" && --depth === 0) { closed = index; break; }
            if (depth < 0) return false;
        }
        if (closed < 0) return false;
        const tail = values.slice(closed + 1).join(" ");
        if (kind === "TABLE") return ["", "STRICT", "WITHOUT ROWID", "STRICT , WITHOUT ROWID", "WITHOUT ROWID , STRICT"].includes(tail);
        // SQLite validates index expressions; subqueries and DML were rejected.
        return tail === "" || values[closed + 1] === "WHERE";
    }
    if (values[index - 1] !== "ALTER" || values[index++] !== "TABLE" || !identifier(tokens[index++]) || values[index++] !== "ADD") return false;
    if (values[index] === "COLUMN") index++;
    if (!identifier(tokens[index++])) return false;
    const declaration = tokens.slice(index);
    if (!declaration.length || declaration.some((token) => token.kind === "symbol" && !["+", "-"].includes(token.value))) return false;
    if (declaration.some((token) => token.kind === "word" && ["PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "GENERATED", "AS", "CONSTRAINT", "COLLATE"].includes(token.value))) return false;
    const notNull = declaration.some((token, position) => token.value === "NOT" && declaration[position + 1]?.value === "NULL");
    const defaultIndex = declaration.findIndex((token) => token.value === "DEFAULT");
    if (defaultIndex < 0) return !notNull && declaration.every((token) => token.kind === "word" && !["DEFAULT", "NOT"].includes(token.value));
    const defaultTokens = declaration.slice(defaultIndex + 1);
    if (defaultTokens[0]?.value === "+" || defaultTokens[0]?.value === "-") defaultTokens.shift();
    if (defaultTokens.length !== 1) return false;
    const value = defaultTokens[0];
    return (["literal", "number"].includes(value.kind) || ["NULL", "TRUE", "FALSE"].includes(value.value)) && !(notNull && value.value === "NULL");
}

export function validateAutomaticMigration(name, sql) {
    if (!/^\d{4,}_[a-z0-9_]+\.sql$/.test(name)) throw new Error("MIGRATION_NAME_REJECTED");
    if (Object.hasOwn(baselineMigrations, name)) throw new Error(`MIGRATION_REQUIRES_BOOTSTRAP:${name}`);
    if (Number(name.split("_", 1)[0]) < 2) throw new Error("MIGRATION_NAME_REJECTED");
    const statements = migrationStatements(sql);
    if (!statements.every(classify)) throw new Error(`MIGRATION_REQUIRES_REVIEW:${name}`);
    return { name, digest: migrationDigest(sql), statements: statements.map((statement) => statement.sql) };
}

export function migrationPlan(files, appliedNames, recordedChecksums = {}) {
    const names = new Set(appliedNames);
    const local = new Map(files.map((file) => [file.name, file]));
    for (const [name, digest] of Object.entries(baselineMigrations)) {
        if (!local.has(name) || migrationDigest(local.get(name).sql) !== digest) throw new Error(`MIGRATION_BASELINE_CHANGED:${name}`);
        if (names.size && !names.has(name)) throw new Error(`MIGRATION_HISTORY_MISSING:${name}`);
    }
    for (const name of names) {
        if (!local.has(name)) throw new Error(`MIGRATION_HISTORY_MISSING:${name}`);
        const expected = baselineMigrations[name] ?? recordedChecksums[name];
        if (!expected || migrationDigest(local.get(name).sql) !== expected) throw new Error(`MIGRATION_HISTORY_CHANGED:${name}`);
    }
    return [...files].sort((a, b) => a.name.localeCompare(b.name)).filter((file) => !names.has(file.name)).map((file) => Object.hasOwn(baselineMigrations, file.name)
        ? { name: file.name, digest: baselineMigrations[file.name], initial: true, statements: migrationStatements(file.sql).map((statement) => statement.sql) }
        : validateAutomaticMigration(file.name, file.sql));
}
