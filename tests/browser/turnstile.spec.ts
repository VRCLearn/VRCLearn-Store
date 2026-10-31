import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import { messages } from "../../src/i18n";

interface VerificationMock {
    rendered: number;
    removed: string[];
    complete(token: string, attempt?: number): void;
    fail(): void;
    expire(): void;
    timeout(): void;
    policy(): { retry: string; expired: string; timeout: string };
}

declare global {
    interface Window { verificationMock?: VerificationMock; }
}

// Mock only the public Turnstile SDK boundary. Tokens stay local to these tests;
// no challenge, authentication request, or external service is bypassed in app code.
const widgetScript = `
    const attempts = [];
    const controls = {
        rendered: 0,
        removed: [],
        complete(token, attempt = attempts.length - 1) { attempts[attempt].callback(token); },
        fail() { attempts.at(-1)["error-callback"]("300030"); },
        expire() { attempts.at(-1)["expired-callback"](); },
        timeout() { attempts.at(-1)["timeout-callback"](); },
        policy() {
            const options = attempts.at(-1);
            return { retry: options.retry, expired: options["refresh-expired"], timeout: options["refresh-timeout"] };
        }
    };
    window.verificationMock = controls;
    window.turnstile = {
        render(_element, options) { attempts.push(options); return "verification-" + (++controls.rendered); },
        remove(id) { controls.removed.push(id); }
    };
`;

async function routeAccount(page: Page) {
    await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/me") return route.fulfill({ json: { user: null } });
        if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-widget-mock" } });
        return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Unexpected local test request" } });
    });
}

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`verification invalidation and explicit Material retry in ${locale}`, async ({ page }) => {
        const t = messages(locale);
        await routeAccount(page);
        await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({ contentType: "application/javascript", body: widgetScript }));
        await page.goto(`/${locale}/account`);
        const submit = page.locator("form").getByRole("button", { name: t.login, exact: true });
        await expect(submit).toBeDisabled();
        await expect.poll(() => page.evaluate(() => window.verificationMock?.rendered)).toBe(1);
        await expect(page.getByRole("progressbar", { name: t.turnstilePending, exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.verificationMock!.policy())).toEqual({ retry: "never", expired: "manual", timeout: "manual" });

        await page.evaluate(() => window.verificationMock!.complete("local-first-token"));
        await expect(submit).toBeEnabled();
        await expect(page.getByRole("progressbar", { name: t.turnstilePending, exact: true })).toHaveCount(0);
        await page.evaluate(() => { window.verificationMock!.fail(); window.verificationMock!.fail(); });
        await expect(page.getByRole("alert")).toHaveText(t.turnstileFailed);
        await expect(submit).toBeDisabled();
        expect(await page.evaluate(() => window.verificationMock!.rendered)).toBe(1);

        const retry = page.getByRole("button", { name: t.retryVerification, exact: true });
        await retry.click();
        await expect.poll(() => page.evaluate(() => window.verificationMock!.rendered)).toBe(2);
        expect(await page.evaluate(() => window.verificationMock!.removed)).toEqual(["verification-1"]);
        await page.evaluate(() => window.verificationMock!.complete("stale-removed-token", 0));
        await expect(submit).toBeDisabled();
        await page.evaluate(() => window.verificationMock!.complete("local-retry-token"));
        await expect(submit).toBeEnabled();
        await expect(page.getByRole("alert")).toHaveCount(0);

        await page.evaluate(() => window.verificationMock!.expire());
        await expect(page.getByRole("alert")).toHaveText(t.turnstileExpired);
        await expect(submit).toBeDisabled();
        await retry.click();
        await expect.poll(() => page.evaluate(() => window.verificationMock!.rendered)).toBe(3);
        await page.evaluate(() => window.verificationMock!.complete("local-refreshed-token"));
        await expect(submit).toBeEnabled();

        await page.evaluate(() => window.verificationMock!.timeout());
        await expect(page.getByRole("alert")).toHaveText(t.turnstileTimeout);
        await expect(submit).toBeDisabled();
        await retry.click();
        await expect.poll(() => page.evaluate(() => window.verificationMock!.rendered)).toBe(4);
        await page.evaluate(() => window.verificationMock!.complete("local-final-token"));
        await expect(submit).toBeEnabled();

        await page.getByRole("banner").getByRole("link", { name: t.store, exact: true }).click();
        await expect(page.getByRole("heading", { name: t.tagline, exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.verificationMock!.removed)).toEqual(["verification-1", "verification-2", "verification-3", "verification-4"]);
    });
}

test("verification script loading failure can be retried explicitly", async ({ page }) => {
    const t = messages("en");
    let scriptRequests = 0;
    await routeAccount(page);
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => {
        scriptRequests++;
        return scriptRequests === 1 ? route.abort("failed") : route.fulfill({ contentType: "application/javascript", body: widgetScript });
    });
    await page.goto("/en/account");
    await expect(page.getByRole("alert")).toHaveText(t.turnstileMissing);
    expect(scriptRequests).toBe(1);
    const submit = page.locator("form").getByRole("button", { name: t.login, exact: true });
    await expect(submit).toBeDisabled();
    await page.getByRole("button", { name: t.retryVerification, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.verificationMock?.rendered)).toBe(1);
    expect(scriptRequests).toBe(2);
    await page.evaluate(() => window.verificationMock!.complete("local-loaded-token"));
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a stalled verification configuration request times out and recovers only after explicit retry", async ({ page }) => {
    const t = messages("en");
    let releaseConfiguration = false;
    let configRequests = 0;
    await page.clock.install();
    await routeAccount(page);
    await page.route("**/api/v1/config", (route) => {
        configRequests++;
        if (releaseConfiguration) return route.fulfill({ json: { turnstileSiteKey: "local-widget-mock" } });
        // Leave the network request pending. The component's timeout must abort it.
    });
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({ contentType: "application/javascript", body: widgetScript }));
    const accountLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/me");
    await page.goto("/en/account");
    await (await accountLoaded).finished();
    const submit = page.locator("form").getByRole("button", { name: t.login, exact: true });
    await expect(submit).toBeVisible();
    await expect.poll(() => configRequests).toBeGreaterThan(0);
    const beforeTimeout = configRequests;
    await page.clock.fastForward(15_000);
    await expect(page.getByRole("alert")).toHaveText(t.turnstileMissing);
    await expect(submit).toBeDisabled();
    expect(configRequests).toBe(beforeTimeout);
    expect(await page.evaluate(() => Boolean(window.turnstile))).toBe(false);

    releaseConfiguration = true;
    await page.getByRole("button", { name: t.retryVerification, exact: true }).click();
    await expect.poll(() => configRequests).toBe(beforeTimeout + 1);
    await expect.poll(() => page.evaluate(() => window.verificationMock?.rendered)).toBe(1);
    await page.evaluate(() => window.verificationMock!.complete("local-config-retry-token"));
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a silent verification attempt has visible progress, times out, and rejects its late token", async ({ page }) => {
    const t = messages("en");
    await page.clock.install();
    await routeAccount(page);
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({ contentType: "application/javascript", body: widgetScript }));
    await page.goto("/en/account");
    const submit = page.locator("form").getByRole("button", { name: t.login, exact: true });
    const progress = page.getByRole("progressbar", { name: t.turnstilePending, exact: true });
    await expect.poll(() => page.evaluate(() => window.verificationMock?.rendered)).toBe(1);
    await expect(progress).toBeVisible();
    await expect(page.getByText(t.turnstilePending, { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();

    await page.clock.fastForward(120_000);
    await expect(page.getByRole("alert")).toHaveText(t.turnstileTimeout);
    await expect(progress).toHaveCount(0);
    await expect(submit).toBeDisabled();
    expect(await page.evaluate(() => window.verificationMock!.removed)).toEqual(["verification-1"]);
    await page.evaluate(() => window.verificationMock!.complete("late-expired-attempt-token", 0));
    await expect(submit).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveText(t.turnstileTimeout);

    await page.getByRole("button", { name: t.retryVerification, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.verificationMock!.rendered)).toBe(2);
    await expect(progress).toBeVisible();
    await page.evaluate(() => window.verificationMock!.complete("late-removed-attempt-token", 0));
    await expect(submit).toBeDisabled();
    await page.evaluate(() => window.verificationMock!.complete("local-watchdog-retry-token"));
    await expect(submit).toBeEnabled();
    await expect(progress).toHaveCount(0);

    await page.clock.fastForward(120_000);
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => window.verificationMock!.rendered)).toBe(2);
    await page.evaluate(() => window.verificationMock!.expire());
    await expect(submit).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveText(t.turnstileExpired);
});
