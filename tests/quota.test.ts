import { describe, expect, it } from "vitest";
import { reserveQuota, validQuotaRequest, type QuotaTransaction } from "../worker/quota-core";

function storage() {
    const values = new Map<string, unknown>();
    const tx: QuotaTransaction = {
        async get<T>(key: string) { return values.get(key) as T | undefined; },
        async put<T>(key: string, value: T) { values.set(key, value); },
    };
    return { values, tx };
}

describe("atomic cost reservations", () => {
    it("rejects a replay without charging a second time", async () => {
        const { values, tx } = storage();
        const input = { key: "upload:unique-one", limits: [{ key: "uploads", limit: 2, windowSeconds: 60 }] };
        expect(await reserveQuota(tx, input, 1000)).toEqual({ allowed: true });
        expect(await reserveQuota(tx, input, 2000)).toMatchObject({ allowed: false, duplicate: true });
        expect(values.get("counter:uploads:0")).toEqual({ used: 1, expiresAt: 60000 });
    });

    it("does not partially consume another budget when any limit is exhausted", async () => {
        const { values, tx } = storage();
        await reserveQuota(tx, { key: "first:operation", limits: [{ key: "mail", limit: 1, windowSeconds: 60 }] }, 1);
        const outcome = await reserveQuota(tx, { key: "second:operation", limits: [
            { key: "bytes", limit: 100, windowSeconds: 60, amount: 50 },
            { key: "mail", limit: 1, windowSeconds: 60 },
        ] }, 2);
        expect(outcome.allowed).toBe(false);
        expect(values.has("counter:bytes:0")).toBe(false);
        expect(values.has("reservation:second:operation")).toBe(false);
    });

    it("uses the UTC calendar month including February and leap days", async () => {
        const { tx } = storage();
        const limits = [{ key: "month", limit: 1, windowSeconds: 2_678_400, period: "month" as const }];
        expect((await reserveQuota(tx, { key: "february:first", limits }, Date.parse("2028-02-01T00:00:00Z"))).allowed).toBe(true);
        expect((await reserveQuota(tx, { key: "february:again", limits }, Date.parse("2028-02-29T23:59:59Z"))).allowed).toBe(false);
        expect((await reserveQuota(tx, { key: "march:first", limits }, Date.parse("2028-03-01T00:00:00Z"))).allowed).toBe(true);
    });

    it("keeps a shared quota exact when independent operations are serialized transactionally", async () => {
        const { tx } = storage();
        let chain = Promise.resolve();
        const reserve = (index: number) => {
            const next = chain.then(() => reserveQuota(tx, { key: `request:${index}`, limits: [{ key: "global", limit: 5, windowSeconds: 60 }] }, 1));
            chain = next.then(() => undefined);
            return next;
        };
        const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) => reserve(index)));
        expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(5);
    });

    it("rejects negative amounts, duplicate keys and unbounded request definitions", () => {
        expect(validQuotaRequest({ key: "valid:key", limits: [{ key: "size", limit: 10, amount: -1, windowSeconds: 60 }] })).toBe(false);
        expect(validQuotaRequest({ key: "valid:key", limits: [1, 2].map(() => ({ key: "same", limit: 10, windowSeconds: 60 })) })).toBe(false);
        expect(validQuotaRequest({ key: "x".repeat(161), limits: [] })).toBe(false);
        expect(validQuotaRequest({ key: "valid:key", limits: [null] })).toBe(false);
        expect(validQuotaRequest({ key: "valid:key", limits: [7] })).toBe(false);
    });
});
