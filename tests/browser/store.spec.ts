import { test, expect, type Page } from "@playwright/test";
import type { Product, Workspace } from "../../shared/contracts";
import { messages } from "../../src/i18n";

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

test("static storefront uses Material menus and preserves a customized theme with one recommendation request", async ({ page }, testInfo) => {
    const apiCalls: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/")) apiCalls.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/recommendations", (route) => route.fulfill({ json: { items: [] } }));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/en");
    await expect(page.getByRole("heading", { name: "Find your next expression." })).toBeVisible();
    await expect(page.locator("header md-menu")).toHaveCount(2);
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
    await expect(page.getByRole("menu", { name: "语言", exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "语言", exact: true }).click();
    await page.getByRole("menuitem", { name: "日本語", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    // One request per page load; this test explicitly reloads once.
    expect(apiCalls.map((url) => new URL(url).pathname)).toEqual(["/api/v1/recommendations", "/api/v1/recommendations"]);
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
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    await signIn.focus();
    await signIn.press("Enter");
    await expectAccessibleRole(page, "tab", "Sign in", true);
    await expect(page.getByRole("textbox", { name: "Display name", exact: true })).toHaveCount(0);
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
            id: "product-browser", revisionId: "revision-browser", status: "draft", publishedRegions: [], requestedRegions: [], regionalReviews: [],
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

test("merchant uploads stable PNG bytes and decodes the private preview", async ({ page }) => {
    const productId = "00000000-0000-4000-8000-000000000002";
    const mediaId = "00000000-0000-4000-8000-000000000003";
    const previewUrl = `/api/v1/merchant/media/${mediaId}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const uploads: { body: Buffer | null; headers: Record<string, string> }[] = [];
    let previewRequests = 0;
    const workspace: Workspace = {
        shop: { id: "00000000-0000-4000-8000-000000000001", name: "Local approved shop", description: "Local upload regression", websiteUrl: "https://maker.example" },
        permissions: [{ region: "cn", status: "approved", reason: "" }, { region: "intl", status: "approved", reason: "" }],
        products: [{
            id: productId, revisionId: "00000000-0000-4000-8000-000000000004", status: "draft", publishedRegions: [], requestedRegions: [], regionalReviews: [],
            content: {
                title: "Stable PNG upload", language: "en", summary: "Local image upload", description: "A draft for the binary upload regression.",
                category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "free", price: null, currency: null,
                purchaseUrl: "https://maker.example/product", mediaIds: [], r18: false,
            },
        }],
    };
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
        contentType: "application/javascript",
        body: 'window.turnstile = { render: (_element, options) => { queueMicrotask(() => options.callback("local-upload-token")); return "local-upload-widget"; }, remove: () => {} };',
    }));
    await page.route("**/api/**", (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/v1/merchant/workspace") return route.fulfill({ json: workspace });
        if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-upload-site-key" } });
        if (path === "/api/v1/merchant/uploads" && request.method() === "POST") {
            uploads.push({ body: request.postDataBuffer(), headers: request.headers() });
            return route.fulfill({ status: 201, json: { id: mediaId, previewUrl } });
        }
        if (path === previewUrl && request.method() === "GET") {
            previewRequests++;
            return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: png });
        }
        return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unexpected local test request" } } });
    });
    await page.goto("/en/merchant");
    await page.locator("md-list-item").filter({ hasText: "Stable PNG upload" }).click();
    await page.getByRole("button", { name: "Upload image", exact: true }).click();
    const picker = page.locator(".file-picker");
    const chooserReady = page.waitForEvent("filechooser");
    await picker.getByRole("button", { name: "Choose an image", exact: true }).click();
    const chooser = await chooserReady;
    // An immutable in-memory fixture avoids replacing a file after selection.
    await chooser.setFiles({ name: "stable-upload.png", mimeType: "image/png", buffer: png });
    await expect(picker).toContainText("stable-upload.png");
    const uploadForm = page.locator("form").filter({ has: page.locator('input[type="file"]') });
    const submit = uploadForm.getByRole("button", { name: "Upload image", exact: true });
    await expect(submit).toBeEnabled();
    const uploadedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/merchant/uploads" && response.request().method() === "POST");
    await submit.click();
    expect((await uploadedResponse).status()).toBe(201);
    const preview = page.locator(".upload-previews img");
    await expect(preview).toHaveAttribute("src", previewUrl);
    expect(await preview.evaluate(async (element) => {
        const image = element as HTMLImageElement;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
    })).toEqual({ width: 1, height: 1 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body).toEqual(png);
    expect(uploads[0].headers["content-type"]).toBe("image/png");
    expect(uploads[0].headers["x-product-id"]).toBe(productId);
    expect(uploads[0].headers["x-file-name"]).toBe("stable-upload.png");
    expect(uploads[0].headers["x-turnstile-token"]).toBe("local-upload-token");
    expect(uploads[0].headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(previewRequests).toBeGreaterThan(0);
});

async function arrangeMerchantPublishing(page: Page, options: { revokeCnOnSave?: boolean; rejectSubmit?: boolean; published?: boolean; rejectedIntl?: boolean } = {}) {
    const productId = "00000000-0000-4000-8000-000000000012";
    const submissions: Record<string, unknown>[] = [];
    const saves: Record<string, unknown>[] = [];
    const workspace: Workspace = {
        shop: { id: "00000000-0000-4000-8000-000000000011", name: "Publishing test shop", description: "Local publishing regression", websiteUrl: "https://maker.example" },
        permissions: [{ region: "cn", status: "approved", reason: "" }, { region: "intl", status: "approved", reason: "" }],
        products: [{
            id: productId, revisionId: "00000000-0000-4000-8000-000000000013", status: options.published ? "published" : "draft", publishedRegions: options.published ? ["cn"] : [], requestedRegions: options.published ? options.rejectedIntl ? ["cn", "intl"] : ["cn"] : [],
            regionalReviews: options.published ? [{ region: "cn", status: "approved", reason: "" }, ...(options.rejectedIntl ? [{ region: "intl" as const, status: "rejected" as const, reason: "Please clarify the international purchase license." }] : [])] : [],
            content: {
                title: "Publishing test product", language: "en", summary: "Local publication draft", description: "A draft for the publishing region regression.",
                category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "free", price: null, currency: null,
                purchaseUrl: "https://maker.example/product", mediaIds: [], r18: false,
            },
        }],
    };
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
        contentType: "application/javascript",
        body: 'window.turnstile = { render: (_element, options) => { queueMicrotask(() => options.callback("local-" + options.action + "-token")); return "local-publishing-widget"; }, remove: () => {} };',
    }));
    await page.route("**/api/**", (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/v1/merchant/workspace") return route.fulfill({ json: workspace });
        if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-publishing-site-key" } });
        if (path === `/api/v1/merchant/products/${productId}` && request.method() === "PUT") {
            saves.push(request.postDataJSON());
            workspace.products[0].content = request.postDataJSON();
            workspace.products[0].revisionId = "00000000-0000-4000-8000-000000000014";
            workspace.products[0].status = "draft";
            workspace.products[0].requestedRegions = [];
            workspace.products[0].regionalReviews = [];
            if (options.revokeCnOnSave) workspace.permissions[0].status = "revoked";
            return route.fulfill({ json: { id: productId, revisionId: workspace.products[0].revisionId } });
        }
        if (path === `/api/v1/merchant/products/${productId}/submit` && request.method() === "POST") {
            submissions.push(request.postDataJSON());
            if (options.rejectSubmit) return route.fulfill({ status: 400, json: { error: { code: "INVALID_INPUT", message: "Check input", requestId: "local-submit-reference" } } });
            workspace.products[0].status = "pending";
            workspace.products[0].requestedRegions = request.postDataJSON().regions;
            workspace.products[0].regionalReviews = workspace.products[0].requestedRegions.map((region) => ({ region, status: workspace.products[0].regionalReviews.find((review) => review.region === region)?.status ?? "pending", reason: "" }));
            return route.fulfill({ json: { ok: true, revisionId: workspace.products[0].revisionId } });
        }
        return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unexpected local test request" } } });
    });
    await page.goto("/en/merchant");
    await page.locator("md-list-item").filter({ hasText: "Publishing test product" }).click();
    return { submissions, saves, workspace };
}

test("Adult selection excludes China review and preserves the flag after saving", async ({ page }) => {
    const { submissions, saves } = await arrangeMerchantPublishing(page);
    const t = messages("en");
    const mainland = page.getByRole("checkbox", { name: t.cn, exact: true });
    await mainland.check();
    await page.getByRole("checkbox", { name: t.intl, exact: true }).check();
    await page.getByRole("checkbox", { name: t.adult, exact: true }).check();
    await expect(mainland).not.toBeChecked();
    await expect(mainland).toBeDisabled();
    await expect(page.getByText(t.adultRegionHint, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t.saveDraft, exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].r18).toBe(true);
    await expect(page.getByRole("checkbox", { name: t.adult, exact: true })).toBeChecked();
    await page.getByRole("button", { name: t.submitReview, exact: true }).click();
    await page.getByRole("button", { name: t.confirm, exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0].regions).toEqual(["intl"]);
});

test("Adult revisions of China listings require unpublishing China first", async ({ page }) => {
    const { submissions } = await arrangeMerchantPublishing(page, { published: true });
    const t = messages("en");
    await page.getByRole("checkbox", { name: t.adult, exact: true }).check();
    await page.getByRole("checkbox", { name: t.intl, exact: true }).check();
    await page.getByRole("button", { name: t.saveDraft, exact: true }).click();
    await expect(page.getByRole("button", { name: t.submitReview, exact: true })).toBeDisabled();
    expect(submissions).toEqual([]);
});

test("merchant requests another region for published content without creating a new revision", async ({ page }) => {
    const { submissions, saves, workspace } = await arrangeMerchantPublishing(page, { published: true });
    const t = messages("en");
    const revisionId = workspace.products[0].revisionId;
    await expect(page.getByRole("checkbox", { name: t.cn, exact: true })).toBeChecked();
    await page.getByRole("checkbox", { name: t.intl, exact: true }).check();
    const submitReview = page.getByRole("button", { name: t.submitReview, exact: true });
    await expect(submitReview).toBeEnabled();
    await submitReview.click();
    const confirm = page.getByRole("button", { name: t.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toEqual({ regions: ["cn", "intl"], turnstileToken: "local-submit-token" });
    expect(saves).toEqual([]);
    expect(workspace.products[0].revisionId).toBe(revisionId);
    expect(workspace.products[0].publishedRegions).toEqual(["cn"]);
    await expect(page.getByText(`${t.publishedRegions}: ${t.cn}`, { exact: true })).toBeVisible();
});

test("merchant sees the rejected region reason and saves a fresh revision before requesting it again", async ({ page }) => {
    const { submissions, saves, workspace } = await arrangeMerchantPublishing(page, { published: true, rejectedIntl: true });
    const t = messages("en");
    const revisionId = workspace.products[0].revisionId;
    const reviews = page.locator(`md-list[aria-label="${t.requestedRegions}"]`);
    await expect(reviews.locator("md-list-item")).toHaveCount(2);
    await expect(reviews.locator("md-list-item").filter({ hasText: t.cn })).toContainText(t.approved);
    const rejected = reviews.locator("md-list-item").filter({ hasText: t.intl });
    await expect(rejected).toContainText(t.rejected);
    await expect(rejected).toContainText("Please clarify the international purchase license.");
    await expect(page.getByText(`${t.publishedRegions}: ${t.cn}`, { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: t.intl, exact: true }).check();
    const submitReview = page.getByRole("button", { name: t.submitReview, exact: true });
    await expect(submitReview).toBeDisabled();
    await expect(page.getByText(t.saveBeforeSubmit, { exact: true })).toBeVisible();
    expect(submissions).toEqual([]);
    await page.getByRole("button", { name: t.saveDraft, exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(workspace.products[0].revisionId).not.toBe(revisionId);
    await expect(submitReview).toBeEnabled();
    await submitReview.click();
    await page.getByRole("button", { name: t.confirm, exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toEqual({ regions: ["cn", "intl"], turnstileToken: "local-submit-token" });
});

for (const canRetry of [false, true]) {
    test(`review desk ${canRetry ? "offers" : "hides"} a server-qualified partial publication retry`, async ({ page }) => {
        const t = messages("en");
        const revisionId = "00000000-0000-4000-8000-000000000022";
        const decisions: Record<string, unknown>[] = [];
        const item = {
            id: revisionId, productId: "00000000-0000-4000-8000-000000000021", shopName: "Review test shop", canRetry,
            content: {
                title: "Partial publication", language: "en", summary: "Reviewed for CN", description: "A regional retry regression.",
                category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "free", price: null, currency: null,
                purchaseUrl: "https://maker.example/product", mediaIds: [], r18: false,
            },
            regions: [{ region: "intl", status: "pending", reason: "" }, { region: "cn", status: "approved", reason: "" }],
        };
        await page.route("**/api/**", (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (path === "/api/v1/me") return route.fulfill({ json: { user: { id: "local-reviewer", email: "reviewer@example.com", name: "Reviewer", role: "admin", banned: false } } });
            if (path === "/api/v1/admin/queue") return route.fulfill({ json: { permissions: [], products: [item], shops: [], reports: [] } });
            if (path === `/api/v1/admin/revisions/${revisionId}/review` && request.method() === "POST") {
                decisions.push(request.postDataJSON());
                item.canRetry = false;
                return route.fulfill({ json: { ok: true, published: true } });
            }
            return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unexpected local review request" } } });
        });
        await page.goto("/en/admin");
        await page.locator("summary").filter({ hasText: "Partial publication" }).click();
        const retry = page.getByRole("button", { name: t.retryPublish, exact: true });
        if (!canRetry) {
            await expect(retry).toHaveCount(0);
            expect(decisions).toEqual([]);
            return;
        }
        await expect(retry).toBeVisible();
        await retry.click();
        await expect.poll(() => decisions.length).toBe(1);
        expect(decisions[0]).toMatchObject({ region: "cn", approve: true });
        await expect(retry).toHaveCount(0);
        await expect(page.getByRole("button", { name: t.approve, exact: true })).toHaveCount(1);
    });
}

test("merchant prevents empty publishing regions and brings submission errors into view", async ({ page }) => {
    const { submissions } = await arrangeMerchantPublishing(page, { rejectSubmit: true });
    const t = messages("en");
    const international = page.getByRole("checkbox", { name: t.intl, exact: true });
    await international.check();
    await page.getByRole("button", { name: t.submitReview, exact: true }).click();
    const confirm = page.getByRole("button", { name: t.confirm, exact: true });
    await expect(confirm).toBeEnabled();
    await international.uncheck();
    await expect(confirm).toBeDisabled();
    // A direct form submission must retain the same guard as the disabled button.
    await page.locator("form").filter({ has: confirm }).evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await expect(page.getByRole("alert")).toHaveText(t.selectRegions);
    expect(submissions).toEqual([]);
    await international.check();
    await confirm.scrollIntoViewIfNeeded();
    await expect(page.getByRole("alert")).not.toBeInViewport();
    await confirm.click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toEqual({ regions: ["intl"], turnstileToken: "local-submit-token" });
    const error = page.getByRole("alert");
    await expect(error).toContainText(t.checkFields);
    await expect(error).toBeInViewport();
    expect(await error.evaluate((element) => document.activeElement?.contains(element))).toBe(true);
    await error.getByText(t.errorDetails, { exact: true }).click();
    await expect(error).toContainText("local-submit-reference");
});

for (const revokeCnOnSave of [false, true]) {
    test(`merchant retains ${revokeCnOnSave ? "only approved" : "both approved"} publishing regions after saving a new revision`, async ({ page }) => {
        const { submissions, saves } = await arrangeMerchantPublishing(page, { revokeCnOnSave });
        const t = messages("en");
        await page.getByRole("checkbox", { name: t.cn, exact: true }).check();
        await page.getByRole("checkbox", { name: t.intl, exact: true }).check();
        await page.getByRole("textbox", { name: t.title, exact: true }).fill("Saved publishing draft");
        await page.getByRole("button", { name: t.saveDraft, exact: true }).click();
        await expect.poll(() => saves.length).toBe(1);
        expect(saves[0].title).toBe("Saved publishing draft");
        // The editor still remounts for the fresh revision and resets its confirmation.
        await expect(page.getByRole("textbox", { name: t.title, exact: true })).toHaveValue("Saved publishing draft");
        const mainland = page.getByRole("checkbox", { name: t.cn, exact: true });
        if (revokeCnOnSave) {
            await expect(mainland).not.toBeChecked();
            await expect(mainland).toBeDisabled();
        } else await expect(mainland).toBeChecked();
        await expect(page.getByRole("checkbox", { name: t.intl, exact: true })).toBeChecked();
        await page.getByRole("button", { name: t.submitReview, exact: true }).click();
        await page.getByRole("button", { name: t.confirm, exact: true }).click();
        await expect.poll(() => submissions.length).toBe(1);
        expect(submissions[0]).toEqual({ regions: revokeCnOnSave ? ["intl"] : ["cn", "intl"], turnstileToken: "local-submit-token" });
        await expect(page.getByRole("textbox", { name: t.title, exact: true })).toBeDisabled();
    });
}

test("Chinese Turnstile loading failures remain localized", async ({ page }) => {
    await page.route("**/api/**", (route) => {
        if (route.request().url().endsWith("/me")) return route.fulfill({ json: { user: null } });
        return route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", requestId: "browser-test" } } });
    });
    await page.goto("/zh-CN/account");
    await expect(page.getByRole("alert")).toContainText("验证加载失败，请检查网络后重试。");
    await expect(page.locator("main")).not.toContainText("Service unavailable");
    await expect(page.getByRole("textbox", { name: "邮箱", exact: true })).toBeVisible();
});

test("Chinese registration submits a display nickname and shows an auth guard failure", async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
        contentType: "application/javascript",
        body: 'window.turnstile = { render: (_element, options) => { queueMicrotask(() => options.callback("local-browser-token")); return "local-widget"; }, remove: () => {} };',
    }));
    await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/me") return route.fulfill({ json: { user: null } });
        if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-browser-site-key" } });
        if (path === "/api/auth/sign-up/email") {
            submitted = route.request().postDataJSON();
            return route.fulfill({ status: 403, json: { code: "VERIFICATION_FAILED", message: "Challenge failed", requestId: "auth-registration-reference" } });
        }
        return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Unexpected test request" } });
    });
    await page.goto("/zh-CN/account");
    await page.locator("md-primary-tab").filter({ hasText: "创建账户" }).click();
    const nickname = page.getByRole("textbox", { name: "昵称", exact: true });
    await expect(nickname).toHaveAttribute("autocomplete", "nickname");
    await nickname.fill("测试昵称");
    await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("local-browser@example.com");
    await page.locator('input[type="password"]').fill("a-strong-browser-test-password");
    await page.locator("form").getByRole("button", { name: "创建账户", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(messages("zh-CN").verificationExpired);
    await page.getByRole("alert").getByText("请求编号", { exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("auth-registration-reference");
    await expect(page.locator("main")).not.toContainText("Challenge failed");
    expect(submitted).toMatchObject({ name: "测试昵称", email: "local-browser@example.com" });
    expect(submitted).not.toHaveProperty("username");
});

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`password login opens the account and review desk in ${locale}`, async ({ page }) => {
        const t = messages(locale);
        let signedIn = false;
        let signIn: Record<string, unknown> | undefined;
        const authenticationPaths: string[] = [];
        const user = { id: "local-reviewer", email: "reviewer@example.com", name: "Reviewer", role: "admin", banned: false };
        await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
            contentType: "application/javascript",
            body: 'window.turnstile = { render: (_element, options) => { queueMicrotask(() => options.callback("local-browser-token")); return "local-widget"; }, remove: () => {} };',
        }));
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.startsWith("/api/auth/")) authenticationPaths.push(path);
            if (path === "/api/v1/me") return route.fulfill({ json: { user: signedIn ? user : null } });
            if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-browser-site-key" } });
            if (path === "/api/auth/sign-in/email") {
                signIn = route.request().postDataJSON();
                signedIn = true;
                return route.fulfill({ json: { user, token: "local-test-token", redirect: false } });
            }
            if (path === "/api/v1/admin/queue") return route.fulfill({ json: { permissions: [], products: [], shops: [], reports: [] } });
            return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Unexpected test request" } });
        });
        await page.goto(`/${locale}/account`);
        await page.getByRole("textbox", { name: t.email, exact: true }).fill(user.email);
        await page.locator('input[type="password"]').fill("a-local-browser-test-password");
        await page.locator("form").getByRole("button", { name: t.login, exact: true }).click();
        await expect(page.getByRole("heading", { name: user.name, exact: true })).toBeVisible();
        await expect(page.getByText(user.email, { exact: true })).toBeVisible();
        expect(signIn).toMatchObject({ email: user.email, password: "a-local-browser-test-password" });
        await page.locator("main").getByRole("link", { name: t.admin, exact: true }).click();
        await expect(page.getByRole("heading", { name: t.productsQueue, exact: true })).toBeVisible();
        expect(authenticationPaths).toEqual(["/api/auth/sign-in/email"]);
    });
}

for (const restricted of ["anonymous", "member", "banned"] as const) {
    test(`review desk blocks ${restricted} accounts before loading the queue`, async ({ page }) => {
        let queueRequests = 0;
        await page.route("**/api/**", (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/v1/me") return route.fulfill({ json: { user: restricted === "anonymous" ? null : {
                id: "restricted-reviewer", email: "reviewer@example.com", name: "Reviewer",
                role: restricted === "member" ? "user" : "admin", banned: restricted === "banned",
            } } });
            if (path === "/api/v1/admin/queue") queueRequests++;
            return route.fulfill({ status: 403, json: { error: { code: "ADMIN_REQUIRED", message: "Administrator required" } } });
        });
        await page.goto("/en/admin");
        await expect(page.getByRole("heading", { name: messages("en").adminRequired, exact: true })).toBeVisible();
        expect(queueRequests).toBe(0);
    });
}

test("Material gallery selection remains selected when its current thumbnail is clicked again", async ({ page }) => {
    const product: Product = {
        id: "gallery-browser", shopId: "shop-browser", shopName: "Browser test shop", title: "Gallery test product", language: "en",
        summary: "Gallery test", description: "A product with two images.", category: "avatars", tags: [], compatibleModels: [],
        platforms: ["pc"], pricing: "free", price: null, currency: null, purchaseUrl: "https://maker.example/product", mediaIds: [],
        images: ["/browser-gallery-first.png", "/browser-gallery-second.png"], r18: false, updatedAt: "2026-10-01T00:00:00Z",
    };
    await page.route("**/api/v1/products*", (route) => route.fulfill({ json: { items: [product], nextCursor: null } }));
    await page.route("**/api/v1/products/gallery-browser", (route) => route.fulfill({ json: product }));
    await page.route("**/browser-gallery-*.png", (route) => route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"),
    }));
    await page.goto("/en/search");
    await page.getByRole("link", { name: product.title, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Gallery test product", exact: true })).toBeVisible();
    await expect(page.locator(".thumbnails md-outlined-icon-button")).toHaveCount(2);
    const first = page.getByRole("button", { name: "Images 1", exact: true });
    const second = page.getByRole("button", { name: "Images 2", exact: true });
    const image = page.locator(".main-image img");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(image).toHaveAttribute("src", product.images[0]);
    await expect(image).toHaveJSProperty("naturalWidth", 1);
    await expect(image).toHaveJSProperty("naturalHeight", 1);
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
