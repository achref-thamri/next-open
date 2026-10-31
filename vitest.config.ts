import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/__tests__/**/*.test.ts"],
        restoreMocks: true,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/__tests__/**", "src/main.ts", "src/dryRun.ts", "src/healthcheck.ts"],
            reporter: ["text-summary", "html", "json-summary"],
            // A little below the current numbers, so coverage cannot quietly drop.
            thresholds: { statements: 93, branches: 85, functions: 92, lines: 95 },
        },
    },
});
