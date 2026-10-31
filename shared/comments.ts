import { z } from "zod";

export const COMMENT_BODY_MAX_LENGTH = 2000;
export const COMMENT_PRODUCT_MAX_ROWS = 1000;
export const COMMENT_GLOBAL_MAX_ROWS = 100000;
export const COMMENT_REPORT_GLOBAL_MAX_ROWS = 100000;
export const commentBodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX_LENGTH).refine((body) => !body.includes("\0"), "Comments cannot contain null characters.");
export const commentInputSchema = z.object({ body: commentBodySchema, turnstileToken: z.string().min(1).max(2048) }).strict();
