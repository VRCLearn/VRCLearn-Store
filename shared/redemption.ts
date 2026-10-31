import { z } from "zod";

export const REDEMPTION_CODE_MIN_LENGTH = 8;
export const REDEMPTION_CODE_MAX_LENGTH = 128;
export const DELIVERY_CONTENT_MAX_LENGTH = 4000;
export const REDEMPTION_IMPORT_MAX_ENTRIES = 100;
export const REDEMPTION_IMPORT_MAX_BYTES = 131072;
export const REDEMPTION_PRODUCT_MAX_CODES = 10000;
export const REDEMPTION_SHOP_MAX_CODES = 50000;
export const REDEMPTION_GLOBAL_MAX_CODES = 100000;

export const redemptionCodeSchema = z.string().trim().min(REDEMPTION_CODE_MIN_LENGTH).max(REDEMPTION_CODE_MAX_LENGTH)
    .refine((code) => !/[\p{Cc}\p{Cf}]/u.test(code), "Codes cannot contain control or invisible characters.");

export const redemptionEntriesSchema = z.array(z.object({
    code: redemptionCodeSchema,
    content: z.string().trim().min(1).max(DELIVERY_CONTENT_MAX_LENGTH),
}).strict()).min(1).max(REDEMPTION_IMPORT_MAX_ENTRIES).superRefine((entries, context) => {
    const codes = new Set<string>();
    for (const [index, entry] of entries.entries()) {
        if (codes.has(entry.code)) context.addIssue({ code: "custom", path: [index, "code"], message: "Each code must be unique within this import." });
        codes.add(entry.code);
    }
});
