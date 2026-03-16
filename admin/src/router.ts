import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import UsersListView from './views/UsersListView.vue';
import UserDetailView from './views/UserDetailView.vue';
import UserFormView from './views/UserFormView.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', component: DashboardView },
        { path: '/users', component: UsersListView },
        { path: '/users/new', component: UserFormView },
        { path: '/users/:id', component: UserDetailView },
        { path: '/users/:id/edit', component: UserFormView },
    ],
});

export default router;
