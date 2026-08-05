import { createRouter, createWebHistory } from 'vue-router';

/**
 * Routes that only mean something against the hosted service.
 *
 * API keys authenticate third parties to a remote encoder, and importing an
 * existing HLS output is a server-side S3 operation that left with the SaaS
 * service. Neither is reachable in the desktop build, so the routes are not
 * registered and the bundler drops the views entirely.
 */
const hostedOnlyRoutes = __DESKTOP__
    ? []
    : [
          {
              path: '/keys',
              name: 'api-keys',
              component: () => import('./views/ApiKeysView.vue'),
          },
          {
              path: '/sessions/import',
              name: 'session-import',
              component: () => import('./views/SessionImportView.vue'),
          },
      ];

const router = createRouter({
    history: createWebHistory(),
    routes: [
        ...hostedOnlyRoutes,
        {
            path: '/',
            redirect: '/sessions',
        },
        {
            path: '/sessions',
            name: 'sessions',
            component: () => import('./views/SessionHistoryView.vue'),
        },
        {
            path: '/sessions/new',
            name: 'session-new',
            component: () => import('./views/EncodeView.vue'),
        },
        {
            path: '/sessions/:id',
            name: 'session-detail',
            component: () => import('./views/SessionView.vue'),
        },
        {
            path: '/s3-configs',
            name: 's3-configs',
            component: () => import('./views/S3ConfigsView.vue'),
        },
    ],
});

export default router;
