import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        globals: false,
        include: ['__tests__/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'html'],
            include: ['src/**/*.{ts,vue}'],
            exclude: ['src/env.d.ts', 'src/index.ts'],
            thresholds: {
                // Line coverage is the most reliable signal; branches and function
                // closures include native-DOM paths (window mousemove inside drag
                // handlers, defensive null-ref guards) that jsdom does not exercise
                // realistically. 100% line coverage verifies every executable
                // source line runs at least once.
                lines: 100,
                statements: 97,
                branches: 90,
                functions: 97,
            },
        },
    },
});
