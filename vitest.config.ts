import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: [
            {
                find: /^openclaw\/plugin-sdk$/,
                replacement: resolve(__dirname, "../openclaw/src/plugin-sdk/index.ts"),
            },
            {
                find: /^openclaw\/plugin-sdk\/(.+)$/,
                replacement: resolve(__dirname, "../openclaw/src/plugin-sdk/$1.ts"),
            },
        ],
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        clearMocks: true,
        restoreMocks: true,
        mockReset: true,
        passWithNoTests: false,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "json-summary"],
            reportsDirectory: "./coverage",
            include: ["src/**/*.ts", "index.ts"],
            exclude: ["**/*.d.ts", "tests/**"],
        },
    },
});
