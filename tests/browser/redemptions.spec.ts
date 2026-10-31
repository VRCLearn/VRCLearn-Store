import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import type { Locale, Product, ProductInput, Redemption, SessionUser, Workspace } from "../../shared/contracts";
import { REDEMPTION_IMPORT_MAX_BYTES } from "../../shared/redemption";
import { messages } from "../../src/i18n";

declare global {
    interface Window {
        redemptionWidgetMock?: { rendered: number; actions: string[]; sizes: string[]; complete(token: string): void };
        copiedDelivery?: string;
        deliveryScriptRan?: boolean;
        redemptionTimeouts?: number[];
    }
}

const productId = "00000000-0000-4000-8000-000000000051";
const content: ProductInput = {
    title: "Code redemption browser product", language: "en", summary: "A local redemption fixture", description: "Published product description.",
    category: "tools", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD",
    purchaseUrl: "https://merchant.example.com/buy-code", mediaIds: [], r18: false,
};
const product: Product = { ...content, id: productId, shopId: "00000000-0000-4000-8000-000000000052", shopName: "Code seller", images: [], updatedAt: "2026-10-31T01:00:00.000Z" };
const user: SessionUser = { id: "test-code-owner", email: "owner@example.com", name: "Code test owner", role: "user", banned: false };
const receipt: Redemption = {
    id: "00000000-0000-4000-8000-000000000053", productId, title: content.title,
    content: 'https://downloads.example.com/private\n<script>window.deliveryScriptRan = true</script>\nPrivate instructions <b>remain text</b>.',
    redeemedAt: "2026-10-31T02:00:00.000Z",
};
const workspace: Workspace = {
    shop: { id: product.shopId, name: product.shopName, description: "Local merchant", websiteUrl: "https://merchant.example.com" },
    permissions: [{ region: "intl", status: "approved", reason: "" }],
    products: [{ id: productId, content, revisionId: "00000000-0000-4000-8000-000000000054", status: "draft", publishedRegions: [], requestedRegions: [], regionalReviews: [] }],
};

async function mockWidget(page: Page) {
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
        contentType: "application/javascript",
        body: `
            const attempts = [];
            window.redemptionWidgetMock = {
                rendered: 0, actions: [], sizes: [],
                complete(token) { attempts.at(-1).callback(token); }
            };
            window.turnstile = {
                render(element, options) {
                    attempts.push(options);
                    window.redemptionWidgetMock.actions.push(options.action);
                    window.redemptionWidgetMock.sizes.push(options.size);
                    const widget = document.createElement('div');
                    widget.dataset.redemptionWidget = '';
                    widget.style.width = options.size === 'compact' ? '150px' : '300px';
                    widget.style.height = options.size === 'compact' ? '140px' : '65px';
                    element.append(widget);
                    return 'redemption-widget-' + (++window.redemptionWidgetMock.rendered);
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
    test(`${locale} product redemption stays on demand and anonymous users see a Material sign-in prompt`, async ({ page }) => {
        const calls: string[] = [];
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            calls.push(path);
            if (path === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
            if (path === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
            if (path === "/api/v1/me") return route.fulfill({ json: { user: null } });
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unexpected test request" } } });
        });
        await openProduct(page, locale);
        expect(calls).toEqual(["/api/v1/products", `/api/v1/products/${productId}`]);
        const purchase = page.getByRole("link", { name: t.purchase, exact: true });
        await expect(purchase).toHaveAttribute("href", product.purchaseUrl);
        await expect(purchase).toHaveAttribute("target", "_blank");
        await expect(purchase).toHaveAttribute("rel", "noopener noreferrer nofollow");
        const redeem = page.getByRole("button", { name: t.redeem, exact: true });
        await redeem.focus();
        await page.keyboard.press("Enter");
        // Material's ARIA mixin moves labels to the shadow-root dialog.
        const dialog = page.locator("md-dialog:not(.theme-dialog)");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading", { name: t.signInRequired, exact: true })).toBeVisible();
        await expect(dialog.getByRole("link", { name: t.account, exact: true })).toHaveAttribute("href", `/${locale}/account`);
        expect(calls.filter((path) => path === "/api/v1/me")).toHaveLength(1);
        expect(calls.some((path) => path.endsWith("/redeem") || path.endsWith("/config") || path.endsWith("/redemptions"))).toBe(false);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(redeem).toBeFocused();
    });

    test(`${locale} explicit code attempts reset verification and deliver private plain text without automatic retries`, async ({ page }, testInfo) => {
        const submitted: unknown[] = [];
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        await mockWidget(page);
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { window.copiedDelivery = value; } } });
        });
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
            if (path === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
            if (path === "/api/v1/me") return route.fulfill({ json: { user } });
            if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-redemption-widget" } });
            if (path === `/api/v1/products/${productId}/redeem`) {
                submitted.push(route.request().postDataJSON());
                if (submitted.length === 1) return route.fulfill({ status: 400, json: { error: { code: "CODE_UNAVAILABLE", message: "Do not expose raw server detail", requestId: "local-code-attempt" } } });
                return route.fulfill({ json: receipt });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await openProduct(page, locale);
        await page.getByRole("button", { name: t.redeem, exact: true }).click();
        const dialog = page.locator("md-dialog:not(.theme-dialog)");
        const submit = dialog.locator("form").getByRole("button", { name: t.redeem, exact: true });
        await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(1);
        expect(await page.evaluate(() => window.redemptionWidgetMock!.sizes)).toEqual(["compact"]);
        expect(await dialog.locator("[data-redemption-widget]").evaluate((element) => {
            const widget = element.getBoundingClientRect();
            const contentBox = element.closest('[slot="content"]')!.getBoundingClientRect();
            return widget.width === 150 && widget.left >= contentBox.left && widget.right <= contentBox.right
                && widget.left >= 0 && widget.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
        })).toBe(true);
        await expect(submit).toBeDisabled();
        await dialog.locator("input[type=password]").fill("Invalid-Code-For-Test");
        await page.evaluate(() => window.redemptionWidgetMock!.complete("first-code-test-token"));
        await submit.click();
        await expect(dialog.getByRole("alert")).toContainText(t.codeUnavailable);
        await expect(dialog.getByRole("alert")).not.toContainText("raw server detail");
        await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(2);
        await expect(submit).toBeDisabled();
        expect(submitted).toEqual([{ code: "Invalid-Code-For-Test", turnstileToken: "first-code-test-token" }]);
        await dialog.locator("input[type=password]").fill("Different-Valid-Test-Code");
        await page.evaluate(() => window.redemptionWidgetMock!.complete("second-code-test-token"));
        await submit.click();
        const success = page.locator("md-dialog:not(.theme-dialog)");
        await expect(success).toBeVisible();
        await expect(success.locator('[slot="headline"]')).toHaveText(t.redemptionComplete);
        await expect(success.locator("textarea")).toHaveValue(receipt.content);
        await expect(success.locator("textarea")).toHaveJSProperty("readOnly", true);
        await expect(success.locator("input[type=password]")).toHaveCount(0);
        await expect(success.locator("script, b")).toHaveCount(0);
        expect(await page.evaluate(() => window.deliveryScriptRan)).toBeUndefined();
        await success.getByRole("button", { name: t.copyContent, exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.copiedDelivery)).toBe(receipt.content);
        await expect(success.getByRole("link", { name: t.myRedemptions, exact: true })).toHaveAttribute("href", `/${locale}/account#redemptions`);
        expect(submitted).toHaveLength(2);
        expect(await page.evaluate(() => window.redemptionWidgetMock!.actions)).toEqual(["redeem", "redeem"]);
    });

    test(`${locale} merchants import per-code delivery data only after explicitly opening inventory`, async ({ page }, testInfo) => {
        let reads = 0;
        const imports: unknown[] = [];
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        await mockWidget(page);
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/v1/merchant/workspace") return route.fulfill({ json: workspace });
            if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-import-widget" } });
            if (path === `/api/v1/merchant/products/${productId}/codes`) {
                if (route.request().method() === "GET") { reads++; return route.fulfill({ json: { total: imports.length, available: imports.length, redeemed: 0 } }); }
                imports.push(route.request().postDataJSON());
                return route.fulfill({ json: { imported: 1 } });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await page.goto(`/${locale}/merchant`);
        await page.locator(".merchant-products md-list-item").filter({ hasText: content.title }).click();
        const inventory = page.locator("details").filter({ has: page.locator("summary").getByText(t.codeInventory, { exact: true }) });
        await expect(inventory.locator("summary")).toBeVisible();
        expect(reads).toBe(0);
        expect(await page.evaluate(() => window.redemptionWidgetMock?.rendered ?? 0)).toBe(0);
        await inventory.locator("summary").click();
        await expect.poll(() => reads).toBe(1);
        await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(1);
        expect(await page.evaluate(() => window.redemptionWidgetMock!.sizes)).toEqual(["compact"]);
        expect(await inventory.locator("[data-redemption-widget]").evaluate((element) => {
            const widget = element.getBoundingClientRect();
            return widget.width === 150 && widget.left >= 0 && widget.right <= innerWidth
                && document.documentElement.scrollWidth <= innerWidth;
        })).toBe(true);
        await page.evaluate(() => window.redemptionWidgetMock!.complete("local-import-token"));
        const input = inventory.locator("textarea");
        const submit = inventory.getByRole("button", { name: t.importCodes, exact: true });
        await input.fill(JSON.stringify([{ code: "Duplicate-Code-Test", content: "first" }, { code: "Duplicate-Code-Test", content: "second" }]));
        await submit.click();
        await expect(inventory.getByRole("alert")).toContainText(t.codeImportInvalid);
        expect(imports).toEqual([]);
        await inventory.locator("input[type=file]").setInputFiles({ name: "too-large.json", mimeType: "application/json", buffer: Buffer.alloc(REDEMPTION_IMPORT_MAX_BYTES + 1, " ") });
        await expect(inventory.getByRole("alert")).toContainText(t.codeImportHint);
        await expect(input).toHaveValue("");
        expect(imports).toEqual([]);
        const entry = { code: "Private-Random-Test-Code", content: "https://downloads.example.com/one-private-key\nUse your own license." };
        await inventory.locator("input[type=file]").setInputFiles({ name: "codes.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([entry])) });
        await expect(input).toHaveValue(JSON.stringify([entry]));
        await submit.click();
        await expect(inventory.getByRole("status")).toContainText(t.codeImportComplete);
        await expect(input).toHaveValue("");
        await expect.poll(() => reads).toBe(2);
        await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(2);
        await expect(submit).toBeDisabled();
        expect(imports).toEqual([{ entries: [entry], turnstileToken: "local-import-token" }]);
        expect(await page.evaluate(() => window.redemptionWidgetMock!.actions)).toEqual(["import-codes", "import-codes"]);
    });

    test(`${locale} account redemption history loads on request, paginates explicitly and supports receipt deep links`, async ({ page }) => {
        const historyCalls: string[] = [];
        const second = { ...receipt, id: "00000000-0000-4000-8000-000000000055", title: "Second redeemed product", content: "Another private delivery." };
        await page.route("**/api/**", (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === "/api/v1/me") return route.fulfill({ json: { user } });
            if (url.pathname === "/api/v1/redemptions") {
                historyCalls.push(url.search);
                return route.fulfill({ json: { items: [url.searchParams.has("cursor") ? second : receipt], nextCursor: url.searchParams.has("cursor") ? null : "local-next-cursor" } });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await page.goto(`/${locale}/account`);
        await expect(page.getByRole("heading", { name: user.name, exact: true })).toBeVisible();
        expect(historyCalls).toEqual([]);
        const history = page.locator("#redemptions");
        await history.locator("summary").click();
        await expect(history.locator("textarea")).toHaveValue(receipt.content);
        expect(historyCalls).toEqual([""]);
        await history.getByRole("button", { name: t.loadMore, exact: true }).click();
        await expect(history.locator("textarea")).toHaveCount(2);
        await expect(history.locator("textarea").nth(1)).toHaveValue(second.content);
        await expect(history.getByRole("button", { name: t.loadMore, exact: true })).toHaveCount(0);
        expect(historyCalls).toEqual(["", "?cursor=local-next-cursor"]);
        await page.goto(`/${locale}/account#redemptions`);
        await page.reload();
        await expect(history).toHaveAttribute("open", "");
        await expect(history.locator("textarea")).toHaveValue(receipt.content);
        expect(historyCalls).toEqual(["", "?cursor=local-next-cursor", ""]);
    });
}

test("unconfirmed redemption and import requests time out without replay and leave recovery controls usable", async ({ page }) => {
    const t = messages("en");
    const posts: string[] = [];
    let inventoryReads = 0;
    await mockWidget(page);
    await page.addInitScript(() => {
        const original = AbortSignal.timeout.bind(AbortSignal);
        window.redemptionTimeouts = [];
        AbortSignal.timeout = (milliseconds: number) => {
            if (milliseconds !== 15_000) return original(milliseconds);
            window.redemptionTimeouts!.push(milliseconds);
            const controller = new AbortController();
            window.setTimeout(() => controller.abort(new DOMException("Local request timeout", "TimeoutError")), 50);
            return controller.signal;
        };
    });
    await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/products") return route.fulfill({ json: { items: [product], nextCursor: null } });
        if (path === `/api/v1/products/${productId}`) return route.fulfill({ json: product });
        if (path === "/api/v1/me") return route.fulfill({ json: { user } });
        if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-timeout-widget" } });
        if (path === "/api/v1/merchant/workspace") return route.fulfill({ json: workspace });
        if (path === `/api/v1/merchant/products/${productId}/codes` && route.request().method() === "GET") {
            inventoryReads++;
            return route.fulfill({ json: { total: 0, available: 0, redeemed: 0 } });
        }
        if (route.request().method() === "POST") {
            posts.push(path);
            // Leave the transport pending. Only the application's AbortSignal
            // should end the attempt; the test does not manufacture a response.
            return;
        }
        return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    });
    await openProduct(page, "en");
    const redeem = page.getByRole("button", { name: t.redeem, exact: true });
    await redeem.click();
    const dialog = page.locator("md-dialog:not(.theme-dialog)");
    await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(1);
    await dialog.locator("input[type=password]").fill("Timeout-Redemption-Code");
    await page.evaluate(() => window.redemptionWidgetMock!.complete("local-timeout-code-token"));
    await dialog.locator("form").getByRole("button", { name: t.redeem, exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(t.redemptionTimeout);
    await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(2);
    expect(await page.evaluate(() => window.redemptionTimeouts)).toEqual([15_000]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(redeem).toBeFocused();
    expect(posts).toEqual([`/api/v1/products/${productId}/redeem`]);

    await page.goto("/en/merchant");
    await page.locator(".merchant-products md-list-item").filter({ hasText: content.title }).click();
    const inventory = page.locator("details").filter({ has: page.locator("summary").getByText(t.codeInventory, { exact: true }) });
    await inventory.locator("summary").click();
    await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(1);
    await inventory.locator("textarea").fill(JSON.stringify([{ code: "Timeout-Inventory-Code", content: "Pending private delivery" }]));
    await page.evaluate(() => window.redemptionWidgetMock!.complete("local-timeout-import-token"));
    const submit = inventory.getByRole("button", { name: t.importCodes, exact: true });
    await submit.click();
    await expect(inventory.getByRole("alert")).toContainText(t.codeImportTimeout);
    await expect.poll(() => page.evaluate(() => window.redemptionWidgetMock?.rendered)).toBe(2);
    await expect(submit).toBeDisabled();
    expect(await page.evaluate(() => window.redemptionTimeouts)).toEqual([15_000]);
    await inventory.getByRole("button", { name: t.refresh, exact: true }).click();
    await expect.poll(() => inventoryReads).toBe(2);
    expect(posts).toEqual([`/api/v1/products/${productId}/redeem`, `/api/v1/merchant/products/${productId}/codes`]);
});
