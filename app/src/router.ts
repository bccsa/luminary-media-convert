import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            redirect: '/sessions',
        },
        {
            path: '/sessions',
            name: 'sessions',
            component: () => import('./views/ActiveSessionsView.vue'),
        },
        {
            path: '/sessions/:id',
            name: 'session-detail',
            component: () => import('./views/SessionView.vue'),
        },
        {
            path: '/sessions/:id/edit',
            name: 'session-edit',
            component: () => import('./views/EditMediaView.vue'),
        },
    ],
});

export default router;
