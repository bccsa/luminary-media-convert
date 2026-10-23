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
    ],
});

export default router;
