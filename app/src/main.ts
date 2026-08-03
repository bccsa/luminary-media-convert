// Deploy trigger: the frontend build only runs on changes under app/, but the
// app bundles encode-config, segment-editor and hls — so fixes landing in those
// never ship on their own (#135). Touching a file here forces the build until
// the trigger covers the workspaces it depends on. Safe to remove once it does.
import { createApp } from 'vue';
import { createAuth0 } from '@auth0/auth0-vue';
import App from './App.vue';
import router from './router';
import './style.css';

const app = createApp(App);

app.use(
    createAuth0({
        domain: import.meta.env.VITE_AUTH0_DOMAIN,
        clientId: import.meta.env.VITE_AUTH0_CLIENT_ID,
        cacheLocation: 'localstorage',
        useRefreshTokens: true,
        authorizationParams: {
            redirect_uri: window.location.origin,
            audience: import.meta.env.VITE_AUTH0_AUDIENCE,
            scope: 'openid profile email',
        },
    })
);

app.use(router);

app.mount('#app');
