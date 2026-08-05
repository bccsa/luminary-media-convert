// Deploy trigger: the frontend build only runs on changes under app/, so the
// trim fixes in #156 and #159 needed a touch here to ship. Delete this comment
// freely — it carries no behaviour, and the next real change to this file
// replaces its purpose.
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
