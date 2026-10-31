import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, expect } from "./fixtures";
import type { CDPSession, Page } from "@playwright/test";
import { messages } from "../../src/i18n";

declare global { interface Window { __fontCLS: number; __fontStart: number } }
const inspectors = new WeakMap<Page, CDPSession>();
const specimen = "VRCLearn StorePrivacy隐私字体测试日本語プライバシーABCD0123456789";
const fonts = [
    { family: "VRCLearn Noto Sans", file: "noto-sans" },
    { family: "VRCLearn Noto Sans SC", file: "noto-sans-sc" },
    { family: "VRCLearn Noto Sans JP", file: "noto-sans-jp" },
].map((font) => ({
    ...font,
    bytes: readFileSync(`tests/fixtures/fonts/${font.file}.woff2`),
    range: Array.from(new Set(Array.from(specimen).filter((character) => font.file !== "noto-sans" || character.codePointAt(0)! < 0x250).map((character) => `U+${character.codePointAt(0)!.toString(16)}`))).join(","),
}));

// A native HTTP cache is needed for the warm-cache assertion. Intercepted font
// responses disable/bypass that cache and cannot model an actual cache hit.
let fontServer: Server;
let fontOrigin: string;
let activeFaces = "";
const responses = new Map<string, { gate: Promise<void>; bytes: Buffer; failed: boolean; state: { requests: number; completed: number } }>();
test.beforeAll(async ({}, workerInfo) => {
    const upstream = workerInfo.project.use.baseURL!;
    fontServer = createServer(async (request, response) => {
        try {
            const font = responses.get(request.url!);
            if (font) {
                font.state.requests++;
                await font.gate;
                if (font.failed) response.destroy();
                else { response.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000" }); response.end(font.bytes); }
                font.state.completed++;
                return;
            }
            if (request.url!.startsWith("/api/")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"user":null}'); return; }
            const result = await fetch(new URL(request.url!, upstream), { headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(10_000) });
            const headers = Object.fromEntries(result.headers);
            for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) delete headers[name];
            let body = Buffer.from(await result.arrayBuffer());
            if (/\/assets\/index-[^/]+\.css$/.test(request.url!)) {
                const css = body.toString();
                const declarations = css.match(/@font-face\s*\{[^}]*\}/g)!;
                expect(declarations.length).toBeGreaterThanOrEqual(3);
                for (const declaration of declarations) expect(declaration).toMatch(/font-display:\s*optional/);
                body = Buffer.from(activeFaces + css.replace(/@font-face\s*\{[^}]*\}/g, ""));
            }
            response.writeHead(result.status, headers);
            response.end(body);
        } catch { response.writeHead(502); response.end(); }
    });
    await new Promise<void>((resolve) => fontServer.listen(0, "127.0.0.1", resolve));
    fontOrigin = `http://127.0.0.1:${(fontServer.address() as { port: number }).port}`;
});
test.afterAll(async () => { fontServer.closeAllConnections(); await new Promise<void>((resolve) => fontServer.close(() => resolve())); });

async function fontDelivery(page: Page, mode: "ready" | "delayed" | "failed") {
    // Remove the generic UI-only routes: native HTTP cache behavior is part of
    // this test and Playwright request interception disables that cache.
    await page.unrouteAll({ behavior: "wait" });
    const inspector = await page.context().newCDPSession(page);
    await inspector.send("DOM.enable");
    inspectors.set(page, inspector);
    let release = () => {};
    const gate = mode === "delayed" ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
    const state = { requests: 0, completed: 0, release: () => release() };
    const id = crypto.randomUUID();
    for (const font of fonts) responses.set(`/__fonts/${id}/${font.file}.woff2`, { gate, bytes: font.bytes, failed: mode === "failed", state });
    activeFaces = fonts.map((font) => `@font-face {
        font-family: '${font.family}'; font-style: normal; font-weight: 400 700;
        font-display: optional; unicode-range: ${font.range};
        src: url('${fontOrigin}/__fonts/${id}/${font.file}.woff2') format('woff2');
    }`).join("\n");
    await page.addInitScript(() => {
        window.__fontCLS = 0;
        window.__fontStart = 0;
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) if (entry.startTime >= window.__fontStart && !(entry as PerformanceEntry & { hadRecentInput: boolean }).hadRecentInput) window.__fontCLS += (entry as PerformanceEntry & { value: number }).value;
        }).observe({ type: "layout-shift", buffered: true });
    });
    if (mode === "ready") {
        await inspector.send("Network.enable");
        await inspector.send("Network.setCacheDisabled", { cacheDisabled: false });
    }
    return state;
}

async function snapshot(page: Page) {
    return page.evaluate(() => ({
        cls: window.__fontCLS,
        boxes: Array.from(document.querySelectorAll(".information-page h1, .information-page p, header md-filled-tonal-icon-button")).map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
        }),
    }));
}

async function headingPixels(page: Page) {
    const clip = await page.locator(".information-page h1").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, scale: 1 };
    });
    // Normal screenshots wait for fonts.ready, which would deadlock a withheld
    // response. Capture the current pixels without waiting for the pending font.
    return (await inspectors.get(page)!.send("Page.captureScreenshot", { format: "png", clip })).data;
}

async function renderedFonts(page: Page) {
    const session = inspectors.get(page)!;
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".information-page h1" });
    return (await session.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
}

for (const locale of ["en", "zh-CN", "ja"] as const) {
    test(`${locale} late Noto fonts never replace visible fallback text or move the layout`, async ({ page }) => {
        const delivery = await fontDelivery(page, "delayed");
        try {
            await page.goto(`${fontOrigin}/${locale}/privacy`, { waitUntil: "domcontentloaded" });
            await page.locator(".information-page").waitFor({ state: "visible" });
            await expect.poll(() => delivery.requests).toBeGreaterThan(0);
            // Exceed optional's brief initial block period before releasing bytes.
            await page.waitForTimeout(300);
            const picture = await headingPixels(page);
            await page.evaluate(() => { window.__fontStart = performance.now(); window.__fontCLS = 0; });
            const before = await snapshot(page);
            delivery.release();
            await expect.poll(() => delivery.completed).toBeGreaterThan(0);
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await page.waitForTimeout(150);
            expect(await snapshot(page)).toEqual(before);
            expect(await headingPixels(page)).toBe(picture);
        } finally { delivery.release(); }
    });

    test(`${locale} ready Noto fonts and a warmed document use the same family in content and controls`, async ({ page }, testInfo) => {
        const delivery = await fontDelivery(page, "ready");
        await page.goto(`${fontOrigin}/${locale}/privacy`);
        await page.locator(".information-page").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const downloaded = delivery.requests;
        await page.reload();
        await page.locator(".information-page").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(delivery.requests).toBe(downloaded);
        expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/__fonts/") && (entry as PerformanceResourceTiming).transferSize === 0 && (entry as PerformanceResourceTiming).decodedBodySize > 0))).toBe(true);
        expect((await renderedFonts(page)).some((font) => font.familyName.includes("Noto Sans"))).toBe(true);
        await page.locator("header").getByRole("button", { name: messages(locale).language, exact: true }).click();
        const families = await page.evaluate(() => {
            const label = document.querySelector('header md-menu-item > span[slot="headline"]')!;
            return { body: getComputedStyle(document.body).fontFamily, component: getComputedStyle(label).fontFamily };
        });
        expect(families.component).toBe(families.body);
        expect(families.body.indexOf(locale === "ja" ? "Noto Sans JP" : "Noto Sans SC")).toBeLessThan(families.body.indexOf(locale === "ja" ? "Noto Sans SC" : "Noto Sans JP"));
        await page.screenshot({ path: `output/playwright/noto-${locale}-${testInfo.project.name}.png`, fullPage: true });
    });
}

test("failed Google fonts preserve readable and stable account navigation", async ({ page }) => {
    await fontDelivery(page, "failed");
    await page.goto(`${fontOrigin}/zh-CN/privacy`);
    await page.locator(".information-page").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const before = await snapshot(page);
    await page.waitForTimeout(150);
    expect(await snapshot(page)).toEqual(before);
    await page.locator("header").getByRole("button", { name: "账户", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "收藏", exact: true })).toBeVisible();
});
