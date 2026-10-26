import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/browser/**"],
        environment: "node",
        server: { deps: { inline: ["@material/material-color-utilities"] } },
        testTimeout: 15000
    }
});
