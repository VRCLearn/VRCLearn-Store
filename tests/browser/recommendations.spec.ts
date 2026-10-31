import { test, expect } from "./fixtures";

test("home recommendations load once and retain static content on failure with explicit retry", async ({ page }) => {
    let calls = 0;
    await page.clock.install();
    await page.route("**/api/v1/recommendations", (route) => {
        calls++;
        if (calls === 1) return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable" } } });
        return route.fulfill({ json: { items: [{
            id: "featured-one", shopId: "shop-one", shopName: "Featured maker", title: "Featured avatar", summary: "An original creation",
            description: "Description", language: "en", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"],
            pricing: "free", price: null, currency: null, purchaseUrl: "https://maker.example/product", mediaIds: [], images: [], r18: false, updatedAt: "2026-10-28T00:00:00Z",
        }] } });
    });
    await page.goto("/en");
    await expect(page.getByRole("heading", { name: "Find your next expression.", exact: true })).toBeVisible();
    const recommendations = page.getByRole("region", { name: "Featured products", exact: true });
    await expect(recommendations.getByRole("alert")).toBeVisible();
    await page.clock.fastForward(60_000);
    expect(calls).toBe(1);
    await recommendations.getByRole("button", { name: "Try loading again", exact: true }).click();
    await expect(recommendations.getByRole("heading", { name: "Featured avatar", exact: true })).toBeVisible();
    await expect(recommendations.getByRole("link", { name: "Featured avatar", exact: true })).toHaveAttribute("href", "/en/products/featured-one");
    await page.clock.fastForward(60_000);
    expect(calls).toBe(2);
});
