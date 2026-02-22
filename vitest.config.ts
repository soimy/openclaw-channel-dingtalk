import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        clearMocks: true,
        restoreMocks: true,
        mockReset: true,
        passWithNoTests: false,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            reportsDirectory: './coverage',
            include: ['src/**/*.ts', 'index.ts'],
            exclude: ['**/*.d.ts', 'tests/**'],
        },
    },
});
