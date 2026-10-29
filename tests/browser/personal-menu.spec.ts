import { expect, test } from "@playwright/test";
import { messages } from "../../src/i18n";

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`personal menu keeps account navigation behind the avatar in ${locale}`, async ({ page }) => {
        const t = messages(locale);
        const requests: string[] = [];
        await page.route("**/api/**", (route) => {
            requests.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" } } });
        });
        await page.goto(`/${locale}/privacy`);
        const header = page.locator("header");
        const avatar = header.getByRole("button", { name: t.account, exact: true });
        const menu = header.locator("md-menu").filter({ has: page.getByRole("menuitem", { name: t.account, exact: true }) });
        await expect(header.getByRole("link", { name: t.account, exact: true })).toHaveCount(0);
        await expect(header.getByRole("link", { name: t.favorites, exact: true })).toHaveCount(0);
        await expect(header.getByRole("link", { name: t.merchant, exact: true })).toHaveCount(0);
        expect(requests).toEqual([]);
        await avatar.click();
        await expect(page).toHaveURL(`/${locale}/privacy`);
        await expect(avatar).toHaveAttribute("aria-expanded", "true");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.favorites, exact: true })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.merchant, exact: true })).toBeVisible();
        await expect.poll(() => requests).toEqual(["/api/v1/me"]);
        await expect(menu.getByRole("menuitem", { name: t.account, exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).not.toBeVisible();
        await expect(avatar).toHaveAttribute("aria-expanded", "false");

        await avatar.press("ArrowDown");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.account, exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`/${locale}/account`);
        await expect(menu).not.toBeVisible();
        await expect(avatar).toHaveAttribute("aria-expanded", "false");

        for (const [label, route] of [[t.favorites, "favorites"], [t.merchant, "merchant"]]) {
            await avatar.click();
            await menu.getByRole("menuitem", { name: label, exact: true }).click();
            await expect(page).toHaveURL(`/${locale}/${route}`);
            await expect(menu).not.toBeVisible();
            await expect(avatar).toHaveAttribute("aria-expanded", "false");
        }
    });
}

test("home banners scroll only on demand and link to store categories", async ({ page }) => {
    const t = messages("en");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.route("**/api/**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/en");
    const banners = page.getByRole("region", { name: t.homeBanners, exact: true });
    const track = banners.locator(".home-banner-track");
    await expect(banners.locator("md-filled-card")).toHaveCount(3);
    await expect(banners.getByRole("link", { name: t.browse, exact: true }).nth(0)).toHaveAttribute("href", "/en/search?category=avatars");
    await expect(banners.getByRole("link", { name: t.browse, exact: true }).nth(1)).toHaveAttribute("href", "/en/search?category=worlds");
    await expect(banners.getByRole("link", { name: t.browse, exact: true }).nth(2)).toHaveAttribute("href", "/en/search?category=clothing");
    const before = await track.evaluate((element) => element.scrollLeft);
    await page.clock.fastForward(60_000);
    expect(await track.evaluate((element) => element.scrollLeft)).toBe(before);
    await banners.getByRole("button", { name: t.loadMore, exact: true }).click();
    await expect.poll(() => track.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await banners.getByRole("button", { name: t.back, exact: true }).click();
    await expect.poll(() => track.evaluate((element) => element.scrollLeft)).toBe(0);
});

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`administrator can open the management workspace from the personal menu in ${locale}`, async ({ page }, testInfo) => {
        const t = messages(locale);
        let user: { id: string; email: string; name: string; role: string; banned: boolean } | null = {
            id: "menu-admin", email: "admin@example.com", name: "Menu admin", role: "admin", banned: false,
        };
        let accountRequests = 0;
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/v1/me") {
                accountRequests++;
                return route.fulfill({ json: { user } });
            }
            if (path === "/api/v1/admin/queue") return route.fulfill({ json: { permissions: [], products: [], shops: [], reports: [] } });
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
        });
        await page.goto(`/${locale}/privacy`);
        expect(accountRequests).toBe(0);
        const avatar = page.locator("header").getByRole("button", { name: t.account, exact: true });
        const menu = page.locator("header md-menu").filter({ has: page.getByRole("menuitem", { name: t.account, exact: true }) });
        await Promise.all([
            menu.evaluate((element) => new Promise<void>((resolve) => element.addEventListener("opened", () => resolve(), { once: true }))),
            avatar.press("ArrowDown"),
        ]);
        const admin = menu.getByRole("menuitem", { name: t.admin, exact: true });
        await expect(admin).toBeVisible();
        await expect(menu.locator("md-menu-item").filter({ hasText: t.admin }).locator('md-icon[slot="start"]')).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.favorites, exact: true })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.merchant, exact: true })).toBeVisible();
        expect(accountRequests).toBe(1);
        await page.screenshot({ path: `output/playwright/personal-menu-admin-${locale}-${testInfo.project.name}.png` });
        await Promise.all([
            menu.evaluate((element) => new Promise<void>((resolve) => element.addEventListener("closed", () => resolve(), { once: true }))),
            admin.click(),
        ]);
        await expect(page).toHaveURL(`/${locale}/admin`);
        await expect(page.getByRole("heading", { name: t.admin, exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: `${t.productsQueue} (0)`, exact: true })).toBeVisible();
        const beforeReopen = accountRequests;
        user = null;
        await avatar.click();
        await expect.poll(() => accountRequests).toBe(beforeReopen + 1);
        await expect(admin).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: t.account, exact: true })).toBeVisible();
    });
}

for (const status of ["anonymous", "member", "banned", "unavailable"] as const) {
    test(`personal menu keeps management hidden for ${status} accounts`, async ({ page }) => {
        const t = messages("en");
        await page.route("**/api/v1/me", (route) => status === "unavailable"
            ? route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } })
            : route.fulfill({ json: { user: status === "anonymous" ? null : {
                id: "menu-user", email: "user@example.com", name: "Menu user", role: status === "banned" ? "admin" : "user", banned: status === "banned",
            } } }));
        await page.goto("/en/privacy");
        const response = page.waitForResponse("**/api/v1/me");
        await page.locator("header").getByRole("button", { name: t.account, exact: true }).click();
        await response;
        const menu = page.locator("header md-menu").filter({ has: page.getByRole("menuitem", { name: t.account, exact: true }) });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.admin, exact: true })).toHaveCount(0);
        await expect(menu.getByRole("menuitem", { name: t.favorites, exact: true })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.merchant, exact: true })).toBeVisible();
    });
}
