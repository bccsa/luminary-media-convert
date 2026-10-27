import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'org.bccsa.luminary.playerlab',
    appName: 'Player Lab',
    webDir: 'dist',
    android: {
        // Debug-only lab: test streams come from a MinIO or dev server on the LAN over http.
        allowMixedContent: true,
    },
    server: {
        cleartext: true,
    },
};

export default config;
