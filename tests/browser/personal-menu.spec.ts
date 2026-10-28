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
        await avatar.click();
        await expect(page).toHaveURL(`/${locale}/privacy`);
        await expect(avatar).toHaveAttribute("aria-expanded", "true");
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.favorites, exact: true })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: t.merchant, exact: true })).toBeVisible();
        expect(requests).toEqual([]);
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
