import { test, expect, type Locator } from "@playwright/test";
import { messages } from "../../src/i18n";

async function expectSummaryAlignment(summary: Locator) {
    await expect(summary).toBeVisible();
    const geometry = await summary.evaluate((element) => {
        const icon = element.querySelector("md-icon")!.getBoundingClientRect();
        const label = element.querySelector(".summary-label > span")!.getBoundingClientRect();
        return {
            centerDifference: Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2),
            gap: label.left - icon.right,
        };
    });
    expect(geometry.centerDifference).toBeLessThanOrEqual(1);
    expect(geometry.gap).toBeGreaterThanOrEqual(8);
}

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`${locale} disclosure icons align with labels and queue counts stay in the heading`, async ({ page }, testInfo) => {
        const t = messages(locale);
        if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 850 });
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/v1/me") return route.fulfill({ json: { user: { id: "layout-admin", email: "layout@example.com", name: "Layout", role: "admin", banned: false } } });
            if (path === "/api/v1/admin/queue") return route.fulfill({ json: { permissions: [], products: [], shops: [], reports: [] } });
            if (path === "/api/v1/merchant/workspace") return route.fulfill({ json: {
                shop: { id: "layout-shop", name: "Layout shop", description: "Layout check", websiteUrl: "https://maker.example" },
                permissions: [], products: [],
            } });
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await page.goto(`/${locale}/admin`);
        const moderation = page.locator(".moderation-tools > summary");
        await expectSummaryAlignment(moderation);
        await expect(page.getByRole("heading", { name: `${t.productsQueue} (0)`, exact: true })).toBeVisible();
        await moderation.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".moderation-tools")).toHaveAttribute("open", "");
        await expectSummaryAlignment(moderation);
        await page.keyboard.press("Enter");
        await expect(page.locator(".moderation-tools")).not.toHaveAttribute("open");
        await page.screenshot({ path: `output/playwright/icon-admin-${locale}-${testInfo.project.name}.png`, fullPage: true });
        await page.goto(`/${locale}/merchant`);
        const permission = page.locator(".permission-application > summary");
        await expectSummaryAlignment(permission);
        await permission.click();
        await expect(page.locator(".permission-application")).not.toHaveAttribute("open");
        await expectSummaryAlignment(permission);
        await page.screenshot({ path: `output/playwright/icon-merchant-${locale}-${testInfo.project.name}.png`, fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
}

test("active filter count and disclosure icon remain inside the search summary", async ({ page }) => {
    await page.route("**/api/v1/products*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/zh-CN/search?platform=ios&tag=avatar");
    const summary = page.locator(".advanced-filters > summary");
    await expect(summary.locator(".filter-count")).toHaveText("(2)");
    const geometry = await summary.evaluate((element) => {
        const container = element.getBoundingClientRect();
        return Array.from(element.children).map((child) => {
            const rect = child.getBoundingClientRect();
            return rect.left >= container.left && rect.right <= container.right && rect.top >= container.top && rect.bottom <= container.bottom;
        });
    });
    expect(geometry).toEqual([true, true]);
    await summary.click();
    await expect(page.locator(".advanced-filters")).not.toHaveAttribute("open");
});
