import { test, expect, type Page } from "@playwright/test";
import type { Product, Workspace } from "../../shared/contracts";

// Material tabs expose their roles through ElementInternals, which Playwright's
// DOM role selector does not read. Check Chromium's real accessibility tree.
async function expectAccessibleRole(page: Page, role: string, name: string, selected?: boolean) {
    const session = await page.context().newCDPSession(page);
    try {
        await expect.poll(async () => {
            const { nodes } = await session.send("Accessibility.getFullAXTree");
            return nodes.some((node) => !node.ignored && node.role?.value === role && node.name?.value === name
                && (selected === undefined || node.properties?.some((property) => property.name === "selected" && property.value.value === selected)));
        }, { message: `Accessible ${role} named ${name}${selected === undefined ? "" : `, selected=${selected}`}` }).toBe(true);
    } finally {
        await session.detach();
    }
}

async function expectReadableHero(page: Page, mobile: boolean) {
    const viewport = page.viewportSize();
    const widths = mobile ? [320, 393] : [viewport?.width ?? 1280];
    for (const width of widths) {
        await page.setViewportSize({ width, height: viewport?.height ?? 850 });
        const fits = await page.evaluate(() => {
            const hero = document.querySelector(".hero")?.getBoundingClientRect();
            const title = document.querySelector(".hero h1")?.getBoundingClientRect();
            return Boolean(hero && title && title.right <= hero.right && title.left >= hero.left
                && document.documentElement.scrollWidth <= window.innerWidth);
        });
        expect(fits, `Readable hero at ${width}px`).toBe(true);
    }
    if (viewport) await page.setViewportSize(viewport);
}

async function expectThemedScrollbar(page: Page) {
    const appearance = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const primary = style.getPropertyValue("--md-sys-color-primary").trim();
        const channels = [1, 3, 5].map((offset) => parseInt(primary.slice(offset, offset + 2), 16));
        return { fine: matchMedia("(pointer: fine)").matches, width: style.scrollbarWidth, color: style.scrollbarColor, expected: `rgb(${channels.join(", ")}) rgba(0, 0, 0, 0)` };
    });
    expect(appearance.width).toBe(appearance.fine ? "thin" : "auto");
    if (appearance.fine) expect(appearance.color).toBe(appearance.expected);
}

test("static storefront uses Material menus and preserves a customized theme without API calls", async ({ page }, testInfo) => {
    const apiCalls: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/")) apiCalls.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/en");
    await expect(page.getByRole("heading", { name: "Find your next expression." })).toBeVisible();
    await expect(page.locator("header md-menu")).toHaveCount(1);
    await expect(page.locator("header md-filled-tonal-icon-button")).toHaveCount(3);
    await expectThemedScrollbar(page);

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    // Slotted content belongs to the host's light DOM, rather than the native
    // dialog inside its shadow root, so scope content queries to the host.
    const dialog = page.locator("md-dialog.theme-dialog");
    await expect(dialog).toBeVisible();
    await expectAccessibleRole(page, "dialog", "Appearance");
    await expect(page.locator("md-dialog md-filter-chip")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await dialog.getByRole("textbox", { name: "Color value", exact: true }).fill("#22aa66");
    await expect(page.locator("html")).toHaveAttribute("data-theme-source", "#22aa66");
    await expectThemedScrollbar(page);
    await dialog.getByRole("combobox", { name: "Color style", exact: true }).click();
    await page.getByRole("option", { name: "Expressive", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "expressive");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("store-appearance") ?? "{}").source)).toBe("#22aa66");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme-source", "#22aa66");
    await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "expressive");

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await dialog.getByRole("button", { name: "Use device setting", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await dialog.getByText("Fine-tune color", { exact: true }).click();
    const beforeFineTune = await page.locator("html").getAttribute("data-theme-source");
    await dialog.getByRole("slider", { name: "Hue", exact: true }).press("ArrowRight");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-source", beforeFineTune ?? "");
    await dialog.getByRole("button", { name: "Reset appearance", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-source", "#6cb6ff");
    await expect(page.locator("html")).toHaveAttribute("data-theme-scheme", "vibrant");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).not.toBeVisible();

    await page.getByRole("button", { name: "Language", exact: true }).press("ArrowDown");
    await page.getByRole("menuitem", { name: "简体中文", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "语言", exact: true }).click();
    await page.getByRole("menuitem", { name: "日本語", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    expect(apiCalls).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll("header select, header button").length)).toBe(0);
    await expectReadableHero(page, testInfo.project.name === "mobile");
    await page.screenshot({ path: `output/playwright/home-${testInfo.project.name}.png`, fullPage: true });
});

test("Material search controls apply only requested filters and do not poll while typing", async ({ page }, testInfo) => {
    const requests: string[] = [];
    await page.route("**/api/v1/products*", (route) => {
        requests.push(route.request().url());
        return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await page.goto("/en/search");
    await expect(page.getByRole("heading", { name: "No matching products", exact: true })).toBeVisible();
    await expect(page.locator(".filter-panel md-outlined-select")).toHaveCount(3);
    await expect(page.locator(".category-chip-row md-filter-chip")).toHaveCount(7);
    expect(await page.evaluate(() => document.querySelectorAll("select, button").length)).toBe(0);
    expect(requests).toHaveLength(1);
    await page.getByRole("textbox", { name: "Product or tag", exact: true }).fill("Avatar");
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "Search products", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(new URL(requests[1]).searchParams.get("q")).toBe("Avatar");
    await expect(page.getByRole("heading", { name: "No matching products", exact: true })).toBeVisible();

    await page.getByRole("combobox", { name: "Platform", exact: true }).click();
    await page.getByRole("option", { name: "Android", exact: true }).click();
    expect(requests).toHaveLength(2);
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(new URL(requests[2]).searchParams.get("platform")).toBe("android");
    await expect(page.getByRole("heading", { name: "No matching products", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Avatars", exact: true }).click();
    await expect.poll(() => requests.length).toBe(4);
    expect(new URL(requests[3]).searchParams.get("category")).toBe("avatars");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByText("No automatic refresh.", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: `output/playwright/search-${testInfo.project.name}.png`, fullPage: true });
});

test("localized search failure provides an explicit one-shot retry", async ({ page }, testInfo) => {
    let requests = 0;
    await page.route("**/api/v1/products*", (route) => {
        requests++;
        return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", requestId: "browser-test" } } });
    });
    await page.goto("/zh-CN/search");
    const alert = page.getByRole("alert");
    await expect(alert.getByRole("heading", { name: "暂时无法加载商品", exact: true })).toBeVisible();
    await expect(alert).toContainText("服务暂时不可用，请稍后重试。");
    await expect(alert).not.toContainText("Service unavailable");
    await expect(page.getByText("页面不会自动刷新", { exact: false })).toHaveCount(0);
    expect(requests).toBe(1);
    await alert.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect.poll(() => requests).toBe(2);
    await expect(alert.getByRole("button", { name: "重新加载", exact: true })).toBeEnabled();
    expect(requests).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `output/playwright/search-error-${testInfo.project.name}.png`, fullPage: true });
});

test("account switcher uses accessible Material tabs and keyboard interaction", async ({ page }) => {
    await page.route("**/api/v1/me", (route) => route.fulfill({ json: { user: null } }));
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: { turnstileSiteKey: "" } }));
    await page.goto("/en/account");
    await expect(page.locator("md-tabs")).toHaveCount(1);
    await expect(page.locator("md-primary-tab")).toHaveCount(2);
    const signIn = page.locator("md-primary-tab").filter({ hasText: "Sign in" });
    const register = page.locator("md-primary-tab").filter({ hasText: "Create account" });
    await expectAccessibleRole(page, "tab", "Sign in", true);
    await expectAccessibleRole(page, "tab", "Create account", false);
    await register.click();
    await expectAccessibleRole(page, "tab", "Create account", true);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    await signIn.focus();
    await signIn.press("Enter");
    await expectAccessibleRole(page, "tab", "Sign in", true);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll("select, button").length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("merchant draft exposes a Material image picker without submitting an upload", async ({ page }) => {
    const writes: string[] = [];
    const workspace: Workspace = {
        shop: { id: "shop-browser", name: "Browser test shop", description: "Test shop", websiteUrl: "https://maker.example" },
        permissions: [{ region: "intl", status: "approved", reason: "" }],
        products: [{
            id: "product-browser", revisionId: "revision-browser", status: "draft", publishedRegions: [], requestedRegions: [],
            content: {
                title: "Upload test product", language: "en", summary: "Test product", description: "A draft for checking the image picker.",
                category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD",
                purchaseUrl: "https://maker.example/product", mediaIds: [], r18: false,
            },
        }],
    };
    await page.route("**/api/**", (route) => {
        const request = route.request();
        if (request.method() !== "GET") writes.push(request.url());
        if (request.url().endsWith("/merchant/workspace")) return route.fulfill({ json: workspace });
        if (request.url().endsWith("/config")) return route.fulfill({ json: { turnstileSiteKey: "" } });
        return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", requestId: "browser-test" } } });
    });
    await page.goto("/en/merchant");
    await expect(page.getByRole("heading", { name: "Browser test shop", exact: true })).toBeVisible();
    await expect(page.locator("md-list md-list-item")).toHaveCount(1);
    await page.locator("md-list-item").filter({ hasText: "Upload test product" }).click();
    await expect(page.getByRole("textbox", { name: "Product title", exact: true })).toHaveValue("Upload test product");
    await page.getByRole("button", { name: "Upload image", exact: true }).click();
    const picker = page.locator(".file-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator("md-outlined-button")).toHaveCount(1);
    await expect(picker.locator("input[type=file]")).toBeHidden();
    const chooseImage = picker.getByRole("button", { name: "Choose an image", exact: true });
    await expect(chooseImage).toBeVisible();
    await expect(chooseImage).toBeEnabled();
    const chooserEvent = page.waitForEvent("filechooser");
    await chooseImage.click();
    expect((await chooserEvent).isMultiple()).toBe(false);
    await expect(picker).toContainText("No image selected");
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll("select, button").length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Chinese account verification failures remain localized", async ({ page }) => {
    await page.route("**/api/**", (route) => {
        if (route.request().url().endsWith("/me")) return route.fulfill({ json: { user: null } });
        return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", requestId: "browser-test" } } });
    });
    await page.goto("/zh-CN/account");
    await expect(page.getByRole("alert")).toContainText("验证服务暂时不可用，请稍后重试。");
    await expect(page.locator("main")).not.toContainText("Service unavailable");
    await expect(page.getByRole("textbox", { name: "邮箱", exact: true })).toBeVisible();
});

test("Material gallery selection remains selected when its current thumbnail is clicked again", async ({ page }) => {
    const product: Product = {
        id: "gallery-browser", shopId: "shop-browser", shopName: "Browser test shop", title: "Gallery test product", language: "en",
        summary: "Gallery test", description: "A product with two images.", category: "avatars", tags: [], compatibleModels: [],
        platforms: ["pc"], pricing: "free", price: null, currency: null, purchaseUrl: "https://maker.example/product", mediaIds: [],
        images: ["/browser-gallery-first.png", "/browser-gallery-second.png"], r18: false, updatedAt: "2026-10-01T00:00:00Z",
    };
    await page.route("**/api/v1/products/gallery-browser", (route) => route.fulfill({ json: product }));
    await page.route("**/browser-gallery-*.png", (route) => route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"),
    }));
    await page.goto("/en/products/gallery-browser");
    await expect(page.getByRole("heading", { name: "Gallery test product", exact: true })).toBeVisible();
    await expect(page.locator(".thumbnails md-outlined-icon-button")).toHaveCount(2);
    const first = page.getByRole("button", { name: "Images 1", exact: true });
    const second = page.getByRole("button", { name: "Images 2", exact: true });
    const image = page.locator(".main-image img");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(image).toHaveAttribute("src", product.images[0]);
    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(image).toHaveAttribute("src", product.images[1]);
    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(image).toHaveAttribute("src", product.images[1]);
});

test("API failure preserves the static storefront and account failures are visible", async ({ page }) => {
    await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", requestId: "browser-test" } } }));
    await page.goto("/en");
    await expect(page.getByRole("heading", { name: "Find your next expression." })).toBeVisible();
    await page.goto("/en/merchant");
    await expect(page.getByRole("alert")).toContainText("unavailable");
    await expect(page.getByRole("alert")).not.toContainText("Service unavailable");
});
