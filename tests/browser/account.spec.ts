import { expect, test } from "./fixtures";
import { messages } from "../../src/i18n";

for (const locale of ["zh-CN", "en", "ja"] as const) {
    test(`registration immediately opens the account and password changes revoke other sessions in ${locale}`, async ({ page }) => {
        const t = messages(locale);
        const user = { id: "browser-new-account", email: "new-account@example.com", name: "New tester", role: "user", banned: false };
        const authPaths: string[] = [];
        let signedIn = false;
        let registration: Record<string, unknown> | undefined;
        let passwordChange: Record<string, unknown> | undefined;
        await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => route.fulfill({
            contentType: "application/javascript",
            body: 'window.turnstile = { render: (_element, options) => { queueMicrotask(() => options.callback("local-browser-token")); return "local-widget"; }, remove: () => {} };',
        }));
        await page.route("**/api/**", (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (path.startsWith("/api/auth/")) authPaths.push(path);
            if (path === "/api/v1/me") return route.fulfill({ json: { user: signedIn ? user : null } });
            if (path === "/api/v1/config") return route.fulfill({ json: { turnstileSiteKey: "local-browser-site-key" } });
            if (path === "/api/auth/sign-up/email") {
                registration = request.postDataJSON();
                signedIn = true;
                return route.fulfill({ json: { user, token: "local-registration-session" } });
            }
            if (path === "/api/auth/change-password") {
                passwordChange = request.postDataJSON();
                return route.fulfill({ json: { user, token: null } });
            }
            return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Unexpected browser request" } });
        });

        await page.goto(`/${locale}/account`);
        await page.locator("md-primary-tab").filter({ hasText: t.register }).click();
        await page.getByRole("textbox", { name: t.displayName, exact: true }).fill(user.name);
        await page.getByRole("textbox", { name: t.email, exact: true }).fill(user.email);
        await page.locator('input[type="password"]').fill("a-local-registration-password");
        await page.locator("form").getByRole("button", { name: t.register, exact: true }).click();
        await expect(page.getByRole("heading", { name: user.name, exact: true })).toBeVisible();
        expect(registration).toMatchObject({ name: user.name, email: user.email, password: "a-local-registration-password" });
        expect(registration).not.toHaveProperty("username");
        expect(authPaths).toEqual(["/api/auth/sign-up/email"]);
        await expect(page.locator("md-tabs")).toHaveCount(0);

        await page.locator("summary").filter({ hasText: t.changePassword }).click();
        await page.getByLabel(t.currentPassword, { exact: true }).fill("a-local-registration-password");
        await page.getByLabel(t.newPassword, { exact: true }).fill("a-new-browser-test-password");
        await page.getByLabel(t.confirmPassword, { exact: true }).fill("a-different-browser-password");
        await page.getByRole("button", { name: t.changePassword, exact: true }).click();
        await expect(page.getByRole("alert")).toContainText(t.passwordMismatch);
        expect(passwordChange).toBeUndefined();
        await page.getByLabel(t.confirmPassword, { exact: true }).fill("a-new-browser-test-password");
        await page.getByRole("button", { name: t.changePassword, exact: true }).click();
        await expect(page.getByRole("status")).toContainText(t.passwordChanged);
        expect(passwordChange).toEqual({ currentPassword: "a-local-registration-password", newPassword: "a-new-browser-test-password", revokeOtherSessions: true });
        expect(authPaths).toEqual(["/api/auth/sign-up/email", "/api/auth/change-password"]);
        for (const label of [t.currentPassword, t.newPassword, t.confirmPassword]) await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
        await expect(page.getByRole("heading", { name: user.name, exact: true })).toBeVisible();
    });
}
