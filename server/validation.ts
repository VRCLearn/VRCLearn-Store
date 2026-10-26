import { z } from "zod";
import { CATEGORIES, LOCALES } from "../shared/contracts";
import { isPublicHttps } from "./security";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const https = z.string().max(2048).refine(isPublicHttps, "A public HTTPS address is required.");
export const regionSchema = z.enum(["cn", "intl"]);
export const shopSchema = z.object({ name: text(100), description: text(4000), websiteUrl: https }).strict();
export const productSchema = z.object({
    title: text(160), language: z.enum(LOCALES), summary: text(400), description: text(12000),
    category: z.enum(CATEGORIES), tags: z.array(text(40)).max(12).transform((items) => [...new Set(items)]),
    compatibleModels: z.array(text(100)).max(20).transform((items) => [...new Set(items)]),
    platforms: z.array(z.enum(["pc", "android"])).min(1).max(2).transform((items) => [...new Set(items)]),
    pricing: z.enum(["free", "paid"]), price: z.number().finite().min(0).max(100000000).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(), purchaseUrl: https,
    mediaIds: z.array(z.string().uuid()).max(10).transform((items) => [...new Set(items)]), r18: z.literal(false),
}).strict().superRefine((value, ctx) => {
    if (value.pricing === "paid" && (value.price === null || value.price <= 0 || !value.currency)) {
        ctx.addIssue({ code: "custom", message: "Paid products need a positive price and currency." });
    }
    if (value.pricing === "free" && (value.price !== null && value.price !== 0)) {
        ctx.addIssue({ code: "custom", message: "Free products cannot have a positive price." });
    }
});
export const decisionSchema = z.object({ approve: z.boolean(), reason: z.string().trim().max(2000).default("") }).strict().refine((value) => value.approve || value.reason.length > 0, "A rejection reason is required.");
export const submitSchema = z.object({ regions: z.array(regionSchema).min(1).max(2).transform((items) => [...new Set(items)]), turnstileToken: text(2048) }).strict();

export function searchTokens(value: string): string[] {
    const normalized = value.normalize("NFKC").toLowerCase();
    const tokens = new Set<string>();
    for (const part of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]+|[\p{L}\p{N}]+/gu) ?? []) {
        if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]+$/u.test(part)) {
            const chars = [...part];
            for (let index = 0; index < chars.length - 1; index++) tokens.add(chars[index] + chars[index + 1]);
            if (chars.length === 1) tokens.add(chars[0]);
        } else tokens.add(part);
    }
    return [...tokens].slice(0, 4096);
}

export function ftsQuery(value: string): string {
    return searchTokens(value).slice(0, 24).map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}
