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
            path: '/sessions',
            name: 'sessions',
            component: () => import('./views/SessionHistoryView.vue'),
        },
        {
            path: '/sessions/import',
            name: 'session-import',
            component: () => import('./views/SessionImportView.vue'),
        },
        {
            path: '/sessions/:id',
            name: 'session-detail',
            component: () => import('./views/SessionView.vue'),
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
