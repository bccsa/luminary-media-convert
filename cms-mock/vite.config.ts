import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    server: {
        // A distinct port keeps the mock's Origin (http://localhost:5199)
        // different from the encoding API's, so the real CORS / origin-gating
        // path is exercised rather than same-origin shortcuts.
        port: 5199,
        strictPort: true,
    },
});
