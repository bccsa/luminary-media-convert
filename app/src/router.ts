import { createRouter, createWebHistory } from 'vue-router';
import EncodeView from './views/EncodeView.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            name: 'encode',
            component: EncodeView,
        },
        {
            path: '/keys',
            name: 'api-keys',
            component: () => import('./views/ApiKeysView.vue'),
        },
        {
            path: '/s3-configs',
            name: 's3-configs',
            component: () => import('./views/S3ConfigsView.vue'),
        },
    ],
});

export default router;
