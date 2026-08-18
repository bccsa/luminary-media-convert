import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        include: ['__tests__/**/*.test.ts'],
        // The suite lands after the player has been verified by hand; until
        // then `__tests__/` does not exist and an empty run is not a failure.
        passWithNoTests: true,
    },
});
