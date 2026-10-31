import { test as base } from "@playwright/test";

// UI-only tests stay offline and keep a deterministic fallback font. Font loading
// tests remove these routes to exercise the real built fonts with native caching.
export const test = base.extend<{ fontDelivery: void }>({
    fontDelivery: [async ({ page }, use) => {
        await page.route("**/assets/*.woff2", (route) => route.abort("failed"));
        await page.route("**/assets/index-*.css", async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace(/@font-face\s*\{[^}]*\}/g, "") });
        });
        await use();
    }, { auto: true }],
});
export { expect } from "@playwright/test";
