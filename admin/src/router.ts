import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import UsersListView from './views/UsersListView.vue';
import UserDetailView from './views/UserDetailView.vue';
import UserFormView from './views/UserFormView.vue';
import SessionsListView from './views/SessionsListView.vue';
import SessionDetailView from './views/SessionDetailView.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', component: DashboardView },
        { path: '/users', component: UsersListView },
        { path: '/users/new', component: UserFormView },
        { path: '/users/:id', component: UserDetailView },
        { path: '/users/:id/edit', component: UserFormView },
        { path: '/sessions', component: SessionsListView },
        { path: '/sessions/:id', component: SessionDetailView },
    ],
});

export default router;
