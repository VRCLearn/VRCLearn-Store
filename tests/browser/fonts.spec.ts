import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, expect } from "./fixtures";
import type { CDPSession, Page } from "@playwright/test";
import { messages } from "../../src/i18n";

declare global { interface Window { __fontCLS: number; __fontStart: number } }
const inspectors = new WeakMap<Page, CDPSession>();
const assetCachePolicy = /\/assets\/\*\r?\n\s+Cache-Control:\s*([^\r\n]+)/.exec(readFileSync("public/_headers", "utf8"))![1];

interface FontDeliveryState {
    requests: number;
    completed: number;
    fonts: Map<string, { requests: number; responses: { status: number; contentType: string; cacheControl: string }[] }>;
    browserRequests: string[];
    errors: string[];
    release: () => void;
}

// A native HTTP cache is needed for the warm-cache assertion. Intercepted font
// responses disable/bypass that cache and cannot model an actual cache hit.
let fontServer: Server;
let fontOrigin: string;
let activeDelivery: { gate: Promise<void>; failed: boolean; state: FontDeliveryState };
test.beforeAll(async ({}, workerInfo) => {
    const upstream = workerInfo.project.use.baseURL!;
    fontServer = createServer(async (request, response) => {
        try {
            if (request.url!.startsWith("/api/")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"user":null}'); return; }
            const delivery = activeDelivery;
            const isFont = new URL(request.url!, upstream).pathname.endsWith(".woff2");
            if (isFont) {
                delivery.state.requests++;
                const font = delivery.state.fonts.get(request.url!) ?? { requests: 0, responses: [] };
                font.requests++;
                delivery.state.fonts.set(request.url!, font);
                await delivery.gate;
                if (delivery.failed) { response.destroy(); delivery.state.completed++; return; }
            }
            const result = await fetch(new URL(request.url!, upstream), { headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(10_000) });
            const headers = Object.fromEntries(result.headers);
            for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) delete headers[name];
            const body = Buffer.from(await result.arrayBuffer());
            if (isFont) {
                // The proxy forwards actual built bytes and CSS unchanged. Its
                // font cache header is the production /assets/* policy, rather
                // than relying on preview-server defaults for cache assertions.
                headers["cache-control"] = assetCachePolicy;
                delivery.state.fonts.get(request.url!)!.responses.push({ status: result.status, contentType: headers["content-type"] ?? "", cacheControl: headers["cache-control"] });
            }
            response.writeHead(result.status, headers);
            response.end(body);
            if (isFont) delivery.state.completed++;
        } catch (error) {
            activeDelivery?.state.errors.push(`${request.url}: ${error instanceof Error ? error.message : String(error)}`);
            if (!response.destroyed) { response.writeHead(502); response.end(); }
        }
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
    const state: FontDeliveryState = { requests: 0, completed: 0, fonts: new Map(), browserRequests: [], errors: [], release: () => release() };
    activeDelivery = { gate, failed: mode === "failed", state };
    page.on("request", (request) => {
        if (request.resourceType() === "font" || new URL(request.url()).pathname.endsWith(".woff2")) state.browserRequests.push(request.url());
    });
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
            const text = document.createRange();
            text.selectNodeContents(element);
            return { box: [rect.x, rect.y, rect.width, rect.height], text: Array.from(text.getClientRects(), (line) => [line.x, line.y, line.width, line.height]) };
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

async function builtFontPolicy(page: Page) {
    const policy = await page.evaluate(() => {
        const faces = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules)
            .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
            .map((rule) => ({
                family: rule.style.getPropertyValue("font-family").replace(/^["']|["']$/g, ""),
                style: rule.style.getPropertyValue("font-style"),
                weight: rule.style.getPropertyValue("font-weight"),
                display: rule.style.getPropertyValue("font-display"),
                range: rule.style.getPropertyValue("unicode-range"),
                urls: Array.from(rule.style.getPropertyValue("src").matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g), (match) => new URL(match[1] ?? match[2] ?? match[3], sheet.href ?? document.baseURI).href),
            })));
        return {
            faces,
            preloads: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"]'), (link) => ({
                href: link.href, type: link.type, crossorigin: link.hasAttribute("crossorigin"), mode: link.crossOrigin,
            })),
        };
    });
    expect(policy.faces.length).toBeGreaterThan(3);
    expect(new Set(policy.faces.map((face) => face.family))).toEqual(new Set(["VRCLearn Noto Sans", "VRCLearn Noto Sans SC", "VRCLearn Noto Sans JP"]));
    for (const face of policy.faces) {
        expect(face.display).toBe("optional");
        expect(face.weight).toMatch(/^400\s+700$/);
        expect(face.range).not.toBe("");
        expect(face.urls.length).toBeGreaterThan(0);
        for (const address of face.urls) {
            const url = new URL(address);
            expect(url.origin).toBe(fontOrigin);
            expect(url.pathname).toMatch(/^\/assets\/.+-[A-Za-z0-9_-]{6,}\.woff2$/);
        }
    }
    expect(policy.preloads).toHaveLength(1);
    const preload = policy.preloads[0];
    expect(preload.type).toBe("font/woff2");
    expect(preload.crossorigin).toBe(true);
    expect(["", "anonymous"]).toContain(preload.mode);
    expect(new URL(preload.href).origin).toBe(fontOrigin);
    expect(new URL(preload.href).pathname).toMatch(/^\/assets\/noto-sans-latin-wght-normal-[A-Za-z0-9_-]{6,}\.woff2$/);
    expect(policy.faces.some((face) => face.family === "VRCLearn Noto Sans" && face.style === "normal" && face.urls.includes(preload.href))).toBe(true);
    return preload.href;
}

function sameOriginFontRequests(delivery: FontDeliveryState) {
    expect(delivery.browserRequests.length).toBeGreaterThan(0);
    for (const address of delivery.browserRequests) {
        const url = new URL(address);
        expect(url.origin).toBe(fontOrigin);
        expect(url.pathname).toMatch(/^\/assets\/.+-[A-Za-z0-9_-]{6,}\.woff2$/);
    }
    expect(delivery.errors).toEqual([]);
}

function successfulBuiltFonts(delivery: FontDeliveryState) {
    sameOriginFontRequests(delivery);
    expect(delivery.completed).toBe(delivery.requests);
    for (const font of delivery.fonts.values()) for (const response of font.responses) {
        expect(response.status).toBe(200);
        expect(response.contentType).toContain("font/woff2");
        expect(response.cacheControl).toBe(assetCachePolicy);
    }
}

for (const locale of ["en", "zh-CN", "ja"] as const) {
    test(`${locale} late Noto fonts never replace visible fallback text or move the layout`, async ({ page }) => {
        const delivery = await fontDelivery(page, "delayed");
        try {
            await page.goto(`${fontOrigin}/${locale}/privacy`, { waitUntil: "domcontentloaded" });
            await page.locator(".information-page").waitFor({ state: "visible" });
            await expect.poll(() => delivery.requests).toBeGreaterThan(0);
            const preload = await builtFontPolicy(page);
            // Exceed optional's brief initial block period before releasing bytes.
            await page.waitForTimeout(300);
            const picture = await headingPixels(page);
            await page.evaluate(() => { window.__fontStart = performance.now(); window.__fontCLS = 0; });
            const before = await snapshot(page);
            delivery.release();
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await expect.poll(() => delivery.completed === delivery.requests).toBe(true);
            await page.waitForTimeout(150);
            expect(await snapshot(page)).toEqual(before);
            expect(await headingPixels(page)).toBe(picture);
            successfulBuiltFonts(delivery);
            expect(delivery.fonts.get(new URL(preload).pathname)?.requests).toBe(1);
        } finally { delivery.release(); }
    });

    test(`${locale} ready Noto fonts and a warmed document use the same family in content and controls`, async ({ page }, testInfo) => {
        const delivery = await fontDelivery(page, "ready");
        await page.goto(`${fontOrigin}/${locale}/privacy`);
        await page.locator(".information-page").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const preload = await builtFontPolicy(page);
        successfulBuiltFonts(delivery);
        expect(delivery.fonts.get(new URL(preload).pathname)?.requests).toBe(1);
        expect(delivery.browserRequests.filter((url) => url === preload)).toHaveLength(1);
        const downloaded = delivery.requests;
        await page.reload();
        await page.locator(".information-page").waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        expect(delivery.requests).toBe(downloaded);
        const cached = await page.evaluate(() => performance.getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname.endsWith(".woff2"))
            .map((entry) => ({ url: entry.name, transferSize: (entry as PerformanceResourceTiming).transferSize, decodedBodySize: (entry as PerformanceResourceTiming).decodedBodySize })));
        expect(cached.length).toBeGreaterThan(0);
        expect(cached.filter((entry) => entry.url === preload)).toHaveLength(1);
        for (const entry of cached) {
            expect(new URL(entry.url).origin).toBe(fontOrigin);
            expect(entry.transferSize).toBe(0);
            expect(entry.decodedBodySize).toBeGreaterThan(0);
        }
        const expectedFamily = locale === "zh-CN" ? "Noto Sans SC" : locale === "ja" ? "Noto Sans JP" : "Noto Sans";
        expect((await renderedFonts(page)).some((font) => font.isCustomFont && font.glyphCount > 0 && font.familyName.includes(expectedFamily))).toBe(true);
        await page.locator("header").getByRole("button", { name: messages(locale).language, exact: true }).click();
        const families = await page.evaluate(() => {
            const label = document.querySelector('header md-menu-item > span[slot="headline"]')!;
            return { body: getComputedStyle(document.body).fontFamily, component: getComputedStyle(label).fontFamily, synthesis: getComputedStyle(document.documentElement).fontSynthesis };
        });
        expect(families.component).toBe(families.body);
        expect(families.synthesis).toBe("none");
        for (const family of ["VRCLearn Noto Sans", "VRCLearn Noto Sans SC", "VRCLearn Noto Sans JP"]) expect(families.body).toContain(family);
        expect(families.body.indexOf(locale === "ja" ? "Noto Sans JP" : "Noto Sans SC")).toBeLessThan(families.body.indexOf(locale === "ja" ? "Noto Sans SC" : "Noto Sans JP"));
        await page.screenshot({ path: `output/playwright/noto-${locale}-${testInfo.project.name}.png`, fullPage: true });
    });
}

test("failed self-hosted fonts preserve readable and stable account navigation", async ({ page }) => {
    const delivery = await fontDelivery(page, "failed");
    await page.goto(`${fontOrigin}/zh-CN/privacy`);
    await page.locator(".information-page").waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await builtFontPolicy(page);
    sameOriginFontRequests(delivery);
    expect(await page.evaluate(() => Array.from(document.fonts).some((font) => font.status === "error"))).toBe(true);
    const before = await snapshot(page);
    await page.waitForTimeout(150);
    expect(await snapshot(page)).toEqual(before);
    await page.locator("header").getByRole("button", { name: "账户", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "收藏", exact: true })).toBeVisible();
});
