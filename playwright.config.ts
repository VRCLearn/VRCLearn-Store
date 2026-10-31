import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/browser",
    fullyParallel: true,
    reporter: "list",
    workers: 2,
    globalTimeout: 240000,
    use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure", channel: "chrome" },
    webServer: process.env.STORE_EXTERNAL_SERVER ? undefined : { command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["Pixel 7"] } }]
});
