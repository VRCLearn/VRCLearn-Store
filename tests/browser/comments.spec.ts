import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { CommentingInfo, Locale, Product, ProductComment } from "../../shared/contracts";
import { messages } from "../../src/i18n";

declare global {
    interface Window {
        commentsWidgetMock?: { rendered: number; actions: string[]; sizes: string[]; complete(token: string): void };
        commentScriptRan?: boolean;
    }
}

test.beforeEach(async ({ page }) => {
    // Unexpected verification requests must fail locally, never reach Cloudflare.
    // The eligible-flow test replaces only the public SDK with its explicit mock.
    await page.route("https://challenges.cloudflare.com/**", (route) => route.abort("blockedbyclient"));
});

const productId = "00000000-0000-4000-8000-000000000061";
const commentId = "00000000-0000-4000-8000-000000000062";
const product: Product = {
    id: productId, shopId: "00000000-0000-4000-8000-000000000063", shopName: "Comment test shop", title: "Redeemed purchaser comments",
    language: "en", summary: "Local comment fixture", description: "A publicly available product.", category: "tools", tags: [], compatibleModels: [],
    platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://merchant.example.com/buy-code", mediaIds: [], images: [], r18: false,
    updatedAt: "2026-11-01T01:00:00.000Z",
};
const first: ProductComment = {
    id: commentId, productId, authorName: "Redeemed creator",
    body: '<script>window.commentScriptRan = true</script>\n<b>This remains plain text.</b>',
    createdAt: "2026-11-01T02:00:00.000Z", updatedAt: "2026-11-01T02:00:00.000Z", verifiedRedemption: true,
};
const second: ProductComment = { ...first, id: "00000000-0000-4000-8000-000000000064", authorName: "Another purchaser", body: "The second page of comments." };

async function mockWidget(page: Page) {
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
        contentType: "application/javascript",
        body: `
            const attempts = [];
            window.commentsWidgetMock = {
                rendered: 0, actions: [], sizes: [],
                complete(token) { attempts.at(-1).callback(token); }
            };
            window.turnstile = {
                render(element, options) {
                    attempts.push(options);
                    window.commentsWidgetMock.actions.push(options.action);
                    window.commentsWidgetMock.sizes.push(options.size);
                    const widget = document.createElement('div');
                    widget.dataset.commentsWidget = '';
                    widget.style.width = options.size === 'compact' ? '150px' : '300px';
                    widget.style.height = options.size === 'compact' ? '140px' : '65px';
                    element.append(widget);
                    return 'comments-widget-' + (++window.commentsWidgetMock.rendered);
                },
                remove() {}
            };
        `,
    }));
}

async function openProduct(page: Page, locale: Locale) {
    await page.goto(`/${locale}/search`);
    await page.getByRole("link", { name: product.title, exact: true }).click();
    await expect(page.getByRole("heading", { name: product.title, exact: true })).toBeVisible();
}

for (const locale of ["zh-CN", "en", "ja"] as const) {
    const t = messages(locale);
    test(`${locale} public comments load only on demand, remain plain text and report the selected comment`, async ({ page }, testInfo) => {
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        const paths: string[] = [];
        const pages: string[] = [];
        const reports: { path: string; body: unknown }[] = [];
        await page.route("**/api/**", (route) => {
            const url = new URL(route.request().url());
            paths.push(url.pathname);
            if (url.pathname === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
            if (url.pathname === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
            if (url.pathname === `/api/v1/products/${productId}/comments`) {
                pages.push(url.search);
                return route.fulfill({ json: {
                    items: [url.searchParams.has("cursor") ? second : { ...first, email: "private-author@example.com", authorId: "private-author-id", deliveryContent: "PRIVATE-DELIVERY-CONTENT" }],
                    nextCursor: url.searchParams.has("cursor") ? null : "local-comment-page",
                } });
            }
            if (url.pathname === `/api/v1/comments/${commentId}/report`) {
                reports.push({ path: url.pathname, body: route.request().postDataJSON() });
                return route.fulfill({ json: { ok: true } });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await openProduct(page, locale);
        expect(paths).toEqual(["/api/v1/products", `/api/v1/products/${productId}`]);
        const comments = page.locator("#comments");
        await expect(comments.getByRole("heading", { name: t.comments, exact: true })).toBeVisible();
        await comments.getByRole("button", { name: t.viewComments, exact: true }).focus();
        await page.keyboard.press("Enter");
        const item = comments.locator(".comment-item").first();
        await expect(item.locator(".comment-body")).toHaveText(first.body);
        await expect(item.getByText(t.verifiedRedemption, { exact: true })).toBeVisible();
        await expect(item.locator("script, b")).toHaveCount(0);
        expect(await page.evaluate(() => window.commentScriptRan)).toBeUndefined();
        await expect(comments).not.toContainText("private-author@example.com");
        await expect(comments).not.toContainText("private-author-id");
        await expect(comments).not.toContainText("PRIVATE-DELIVERY-CONTENT");
        expect(pages).toEqual([""]);
        await comments.getByRole("button", { name: t.loadMore, exact: true }).click();
        await expect(comments.locator(".comment-item")).toHaveCount(2);
        await expect(comments.getByRole("button", { name: t.loadMore, exact: true })).toHaveCount(0);
        expect(pages).toEqual(["", "?cursor=local-comment-page"]);
        const reason = "This specific comment contains a deceptive purchase link.";
        await item.getByRole("button", { name: t.reportComment, exact: true }).click();
        await item.locator("textarea").fill(reason);
        await item.getByRole("button", { name: t.submit, exact: true }).click();
        await expect(item.getByRole("status")).toContainText(t.commentReportComplete);
        expect(reports).toEqual([{ path: `/api/v1/comments/${commentId}/report`, body: { reason } }]);
        expect(paths.some((path) => path.endsWith("/me") || path.endsWith("/commenting") || path.endsWith("/config"))).toBe(false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test(`${locale} anonymous, unredeemed and moderated accounts cannot open a comment form or evade moderation by deleting`, async ({ page }, testInfo) => {
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        let state: "anonymous" | "unredeemed" | "hidden" = "anonymous";
        let hiddenComment: ProductComment | null = first;
        const mutations: string[] = [];
        const paths: string[] = [];
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            paths.push(path);
            if (path === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
            if (path === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
            if (path === `/api/v1/products/${productId}/comments`) return route.fulfill({ json: { items: [], nextCursor: null } });
            if (path === `/api/v1/products/${productId}/commenting`) {
                if (state === "anonymous") return route.fulfill({ status: 401, json: { error: { code: "SIGN_IN_REQUIRED", message: "Sign in required" } } });
                const info: CommentingInfo = state === "unredeemed" ? { eligible: false, hidden: false, comment: null } : { eligible: true, hidden: true, comment: hiddenComment };
                return route.fulfill({ json: info });
            }
            if (path === `/api/v1/comments/${commentId}` && route.request().method() === "DELETE") {
                mutations.push(path); hiddenComment = null;
                return route.fulfill({ json: { ok: true } });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await openProduct(page, locale);
        const comments = page.locator("#comments");
        const editor = comments.locator(".comment-editor");
        await comments.getByRole("button", { name: t.writeComment, exact: true }).click();
        await expect(editor.getByRole("heading", { name: t.signInRequired, exact: true })).toBeVisible();
        await expect(editor.locator("form")).toHaveCount(0);
        state = "unredeemed";
        await comments.getByRole("button", { name: t.writeComment, exact: true }).click();
        await expect(editor.getByText(t.commentRedemptionRequired, { exact: true })).toBeVisible();
        await expect(editor.locator("form")).toHaveCount(0);
        state = "hidden";
        await comments.getByRole("button", { name: t.writeComment, exact: true }).click();
        await expect(editor.getByText(t.commentModerated, { exact: true })).toBeVisible();
        await expect(editor.locator("textarea")).toHaveValue(first.body);
        await expect(editor.locator("textarea")).toHaveJSProperty("readOnly", true);
        await expect(editor.locator("form")).toHaveCount(0);
        await editor.getByRole("button", { name: t.deleteMyComment, exact: true }).click();
        await expect(editor.getByRole("status")).toContainText(t.commentDeleted);
        await expect(editor.locator("textarea")).toHaveCount(0);
        await comments.getByRole("button", { name: t.writeComment, exact: true }).click();
        await expect(editor.getByText(t.commentModerated, { exact: true })).toBeVisible();
        await expect(editor.locator("form")).toHaveCount(0);
        expect(mutations).toEqual([`/api/v1/comments/${commentId}`]);
        expect(paths.filter((path) => path.endsWith("/commenting"))).toHaveLength(4);
        expect(paths.some((path) => path.endsWith("/config"))).toBe(false);
        expect(await page.evaluate(() => window.commentsWidgetMock)).toBeUndefined();
    });

    test(`${locale} redeemed purchasers post, edit and delete one comment with fresh verification and explicit retries`, async ({ page }, testInfo) => {
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        let own: ProductComment | null = null;
        let eligibilityReads = 0;
        const writes: { method: string; path: string; body: unknown }[] = [];
        await mockWidget(page);
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            const method = route.request().method();
            if (path === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
            if (path === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
            if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-comments-widget" } });
            if (path === `/api/v1/products/${productId}/commenting`) {
                eligibilityReads++;
                return route.fulfill({ json: { eligible: true, hidden: false, comment: own } });
            }
            if (path === `/api/v1/products/${productId}/comments` && method === "GET") return route.fulfill({ json: { items: own ? [own] : [], nextCursor: null } });
            if (method === "POST" || method === "PUT" || method === "DELETE") {
                const data = method === "DELETE" ? null : route.request().postDataJSON() as { body: string; turnstileToken: string };
                writes.push({ method, path, body: data });
                if (writes.length === 1) return route.fulfill({ status: 429, json: { error: { code: "RATE_LIMITED", message: "Untranslated server details" } } });
                if (method === "DELETE") { own = null; return route.fulfill({ json: { ok: true } }); }
                own = { ...first, authorName: "Current purchaser", body: data!.body, updatedAt: method === "PUT" ? "2026-11-01T03:00:00.000Z" : first.createdAt };
                return route.fulfill({ json: own });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await openProduct(page, locale);
        const comments = page.locator("#comments");
        await comments.getByRole("button", { name: t.writeComment, exact: true }).click();
        const editor = comments.locator(".comment-editor");
        const text = editor.locator("textarea");
        await expect.poll(() => page.evaluate(() => window.commentsWidgetMock?.rendered)).toBe(1);
        expect(await page.evaluate(() => window.commentsWidgetMock!.sizes)).toEqual(["compact"]);
        expect(await editor.locator("[data-comments-widget]").evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width === 150 && rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
        })).toBe(true);
        const post = editor.getByRole("button", { name: t.postComment, exact: true });
        await expect(post).toBeDisabled();
        const body = "  A comment from a redeemed purchase.\n<script>window.commentScriptRan = true</script>  ";
        await text.fill(body);
        await page.evaluate(() => window.commentsWidgetMock!.complete("first-comment-token"));
        await post.click();
        await expect(editor.getByRole("alert")).toContainText(t.tooManyRequests);
        await expect(editor.getByRole("alert")).not.toContainText("Untranslated server details");
        await expect.poll(() => page.evaluate(() => window.commentsWidgetMock?.rendered)).toBe(2);
        await expect(post).toBeDisabled();
        expect(writes).toEqual([{ method: "POST", path: `/api/v1/products/${productId}/comments`, body: { body: body.trim(), turnstileToken: "first-comment-token" } }]);
        await page.evaluate(() => window.commentsWidgetMock!.complete("retry-comment-token"));
        await post.click();
        await expect(editor.getByRole("status")).toContainText(t.commentSaved);
        await expect(comments.locator(".comment-item .comment-body")).toHaveText(body.trim());
        await expect(comments.locator(".comment-item script")).toHaveCount(0);
        expect(await page.evaluate(() => window.commentScriptRan)).toBeUndefined();
        await expect.poll(() => page.evaluate(() => window.commentsWidgetMock?.rendered)).toBe(3);
        const edit = editor.getByRole("button", { name: t.saveComment, exact: true });
        await expect(edit).toBeDisabled();
        await text.fill("Updated purchase experience.");
        await page.evaluate(() => window.commentsWidgetMock!.complete("edit-comment-token"));
        await edit.click();
        await expect(comments.locator(".comment-item .comment-body")).toHaveText("Updated purchase experience.");
        await expect(comments.locator(".comment-item").getByText(t.commentEdited, { exact: false })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.commentsWidgetMock?.rendered)).toBe(4);
        await editor.getByRole("button", { name: t.deleteMyComment, exact: true }).click();
        await expect(editor.getByRole("status")).toContainText(t.commentDeleted);
        await expect(comments.locator(".comment-item")).toHaveCount(0);
        await expect(text).toHaveValue("");
        await expect(post).toBeDisabled();
        await expect.poll(() => page.evaluate(() => window.commentsWidgetMock?.rendered)).toBe(5);
        expect(writes).toEqual([
            { method: "POST", path: `/api/v1/products/${productId}/comments`, body: { body: body.trim(), turnstileToken: "first-comment-token" } },
            { method: "POST", path: `/api/v1/products/${productId}/comments`, body: { body: body.trim(), turnstileToken: "retry-comment-token" } },
            { method: "PUT", path: `/api/v1/comments/${commentId}`, body: { body: "Updated purchase experience.", turnstileToken: "edit-comment-token" } },
            { method: "DELETE", path: `/api/v1/comments/${commentId}`, body: null },
        ]);
        expect(eligibilityReads).toBe(1);
        expect(await page.evaluate(() => window.commentsWidgetMock!.actions)).toEqual(["comment", "comment", "comment", "comment", "comment"]);
    });
}

test("administrators inspect escaped comment reports and explicitly hide, restore and resolve the selected comment", async ({ page }, testInfo) => {
    if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
    const t = messages("en");
    const reportId = "00000000-0000-4000-8000-000000000065";
    let hidden = false;
    let resolved = false;
    const decisions: { path: string; body: unknown }[] = [];
    await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/me") return route.fulfill({ json: { user: { id: "comment-admin", email: "admin@example.com", name: "Comment administrator", role: "admin", banned: false } } });
        if (path === "/api/v1/admin/queue") return route.fulfill({ json: { permissions: [], products: [], shops: [], reports: resolved ? [] : [{
            id: reportId, productId, reason: "This comment may contain unsafe instructions.", status: "open", commentId,
            commentBody: first.body, commentAuthorName: first.authorName, commentHidden: hidden, commentDeleted: false,
        }] } });
        if (path === `/api/v1/admin/comments/${commentId}/moderate`) {
            const body = route.request().postDataJSON() as { hidden: boolean; reason: string };
            decisions.push({ path, body }); hidden = body.hidden;
            return route.fulfill({ json: { ok: true } });
        }
        if (path === `/api/v1/admin/reports/${reportId}/resolve`) {
            decisions.push({ path, body: route.request().postDataJSON() }); resolved = true;
            return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    });
    await page.goto("/en/admin");
    await page.locator("main md-primary-tab").filter({ hasText: t.reportsQueue }).click();
    const report = page.locator(".review-queues .review-item");
    await expect(report.locator(".comment-body")).toHaveText(first.body);
    await expect(report).toContainText(first.authorName);
    await expect(report.locator("script, b")).toHaveCount(0);
    expect(await page.evaluate(() => window.commentScriptRan)).toBeUndefined();
    await expect(report.getByRole("link", { name: t.details, exact: true })).toHaveAttribute("href", `/en/products/${productId}#comments`);
    await report.getByRole("button", { name: t.hideComment, exact: true }).click();
    await expect(report.getByRole("alert")).toContainText(t.reason);
    expect(decisions).toEqual([]);
    const reason = "Confirmed unsafe instructions in the reported comment.";
    await report.locator("input").fill(reason);
    await report.getByRole("button", { name: t.hideComment, exact: true }).click();
    await expect(report.getByRole("button", { name: t.restoreComment, exact: true })).toBeVisible();
    await report.getByRole("button", { name: t.restoreComment, exact: true }).click();
    await expect(report.getByRole("button", { name: t.hideComment, exact: true })).toBeVisible();
    await report.getByRole("button", { name: t.resolve, exact: true }).click();
    await expect(page.getByRole("heading", { name: `${t.reportsQueue} (0)`, exact: true })).toBeVisible();
    expect(decisions).toEqual([
        { path: `/api/v1/admin/comments/${commentId}/moderate`, body: { hidden: true, reason } },
        { path: `/api/v1/admin/comments/${commentId}/moderate`, body: { hidden: false, reason } },
        { path: `/api/v1/admin/reports/${reportId}/resolve`, body: { reason } },
    ]);
});
