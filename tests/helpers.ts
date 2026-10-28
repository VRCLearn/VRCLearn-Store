import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { AppEnv } from "../server/env";
import type { SessionUser } from "../shared/contracts";

export function sqliteD1(database = new DatabaseSync(":memory:")) {
    const queries: { sql: string; values: SQLInputValue[] }[] = [];
    function prepare(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
        const execute = (rows: boolean) => {
            queries.push({ sql, values });
            const statement = database.prepare(sql);
            const results = rows ? statement.all(...values) : [];
            const run = rows
                ? /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql)
                    ? { changes: 0, lastInsertRowid: 0 }
                    : database.prepare("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid").get() as { changes: number; lastInsertRowid: number }
                : statement.run(...values);
            return { success: true, results, meta: { changes: Number(run.changes), last_row_id: Number(run.lastInsertRowid), duration: 0, rows_read: results.length, rows_written: Number(run.changes), size_after: 0, changed_db: Number(run.changes) > 0 } };
        };
        const object = {
            bind(...args: unknown[]) {
                const checked = args.map((value): SQLInputValue => {
                    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
                    throw new TypeError("Invalid SQL binding");
                });
                return prepare(sql, checked);
            },
            async first(column?: string) {
                const row = execute(true).results[0] ?? null;
                return column && row ? row[column] : row;
            },
            async all() { return execute(true); },
            async run() { return execute(false); },
            async raw() { return execute(true).results.map(Object.values); }
        };
        return Object.assign({} as D1PreparedStatement, object);
    }
    const binding = Object.assign({} as D1Database, {
        prepare,
        async batch(statements: D1PreparedStatement[]) {
            database.exec("SAVEPOINT d1batch");
            try {
                const results = [];
                for (const statement of statements) {
                    // D1 batch retains rows from SELECT/PRAGMA/RETURNING statements.
                    results.push(await statement.all());
                }
                database.exec("RELEASE d1batch");
                return results;
            } catch (error) {
                database.exec("ROLLBACK TO d1batch; RELEASE d1batch");
                throw error;
            }
        },
        async exec(sql: string) { database.exec(sql); return { count: 1, duration: 0 }; }
    });
    return { binding, database, queries };
}

export const merchant: SessionUser = { id: "merchant-one", email: "merchant@example.com", name: "Maker", role: "user", emailVerified: true, banned: false };
export const admin: SessionUser = { id: "admin-one", email: "admin@example.com", name: "Reviewer", role: "admin", emailVerified: true, banned: false };

export function testEnvironment() {
    const sql = sqliteD1();
    sql.database.exec(readFileSync("migrations/0001_business.sql", "utf8"));
    sql.database.exec(readFileSync("migrations/0003_revision_storage.sql", "utf8"));
    const state = new Map<string, string>();
    const privateMedia = new Map<string, Uint8Array>();
    const publicMedia = new Map<string, Uint8Array>();
    const users = new Map([["merchant", merchant], ["admin", admin], ["outsider", { ...merchant, id: "merchant-two" }]]);
    const bucket = (objects: Map<string, Uint8Array>) => Object.assign({} as R2Bucket, {
        async put(key: string, body: ArrayBuffer | Uint8Array) { objects.set(key, new Uint8Array(body)); return {}; },
        async get(key: string) {
            const bytes = objects.get(key);
            return bytes ? { body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer, size: bytes.byteLength } : null;
        },
        async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
    });
    const quota = Object.assign({} as DurableObjectNamespace, { getByName: () => ({ fetch: async () => Response.json({ allowed: true }) }) });
    const env: AppEnv = {
        SKIP_DEPENDENCY_INSTALL: "1",
        DB: sql.binding,
        STATE: Object.assign({} as KVNamespace, {
            async get(key: string, type?: string) { const value = state.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; },
            async put(key: string, value: string) { state.set(key, value); }
        }),
        PRIVATE_MEDIA: bucket(privateMedia), PUBLIC_MEDIA: bucket(publicMedia), QUOTA: quota,
        AUTH: Object.assign({} as Fetcher, { fetch: async (request: Request) => Response.json(users.get(request.headers.get("x-test-user") ?? "") ?? null) }),
        ASSETS: Object.assign({} as Fetcher, { fetch: async () => new Response(readFileSync("index.html", "utf8")) }),
        ORIGIN: "https://store.vrclearn.com", MEDIA_ORIGIN: "https://store-media.vrclearn.com", ENVIRONMENT: "test", TURNSTILE_SITE_KEY: "test", TURNSTILE_SECRET_KEY: "test", CF_ZONE_ID: ""
    };
    return { ...sql, env, state, privateMedia, publicMedia };
}

export function edgeRequest(path: string, options: { method?: string; body?: unknown; user?: string; country?: string } = {}): Request {
    const request = new Request(`https://store.vrclearn.com${path}`, {
        method: options.method ?? "GET",
        headers: { "Origin": "https://store.vrclearn.com", "CF-Connecting-IP": "203.0.113.10", "Content-Type": "application/json", ...(options.user ? { "x-test-user": options.user } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    Object.defineProperty(request, "cf", { value: { country: options.country ?? "CN" } });
    return request;
}
