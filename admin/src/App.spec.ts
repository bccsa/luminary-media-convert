import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, type Ref } from 'vue';

// Mock auth0
const mockIsAuthenticated: Ref<boolean> = ref(false);
const mockIsLoading: Ref<boolean> = ref(false);
const mockUser: Ref<Record<string, unknown> | undefined> = ref(undefined);
const mockLoginWithRedirect = vi.fn();
const mockLogout = vi.fn();
const mockGetAccessTokenSilently = vi.fn().mockResolvedValue('test-token');

vi.mock('@auth0/auth0-vue', () => ({
    useAuth0: () => ({
        isAuthenticated: mockIsAuthenticated,
        isLoading: mockIsLoading,
        user: mockUser,
        loginWithRedirect: mockLoginWithRedirect,
        logout: mockLogout,
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

// Mock API
const mockGetCurrentUser = vi.fn();
vi.mock('./api', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

// Mock router-view and router-link
const mockRouterView = { template: '<div data-testid="router-view">Router View</div>' };
const mockRouterLink = { template: '<a><slot /></a>', props: ['to'] };

import App from './App.vue';

describe('App.vue', () => {
    beforeEach(() => {
        mockIsAuthenticated.value = false;
        mockIsLoading.value = false;
        mockUser.value = undefined;
        mockLoginWithRedirect.mockClear();
        mockLogout.mockClear();
        mockGetAccessTokenSilently.mockClear();
        mockGetCurrentUser.mockReset();
    });

    function mountApp() {
        return mount(App, {
            global: {
                stubs: {
                    'router-view': mockRouterView,
                    'router-link': mockRouterLink,
                },
            },
        });
    }

    it('shows loading spinner when Auth0 is loading', () => {
        mockIsLoading.value = true;
        const wrapper = mountApp();
        expect(wrapper.find('svg.animate-spin').exists()).toBe(true);
        expect(wrapper.text()).not.toContain('Sign In');
    });

    it('shows sign in button when not authenticated', () => {
        mockIsLoading.value = false;
        mockIsAuthenticated.value = false;
        const wrapper = mountApp();
        expect(wrapper.text()).toContain('Sign In');
        expect(wrapper.text()).toContain('Sign in to access the admin panel');
    });

    it('calls loginWithRedirect when sign in button clicked', async () => {
        mockIsLoading.value = false;
        mockIsAuthenticated.value = false;
        const wrapper = mountApp();

        await wrapper.find('button').trigger('click');
        expect(mockLoginWithRedirect).toHaveBeenCalled();
    });

    it('shows admin content when authenticated as admin', async () => {
        mockGetCurrentUser.mockResolvedValue({
            id: 'u1',
            email: 'admin@test.com',
            role: 'admin',
        });
        mockUser.value = { email: 'admin@test.com' };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('admin@test.com');
        expect(wrapper.text()).toContain('Sign Out');
        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);
    });

    it('shows access denied for non-admin users', async () => {
        mockGetCurrentUser.mockResolvedValue({
            id: 'u2',
            email: 'user@test.com',
            role: 'user',
        });
        mockUser.value = { email: 'user@test.com' };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('Access denied');
        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(false);
    });

    it('falls back to Auth0 user roles when /me endpoint fails', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        mockUser.value = {
            email: 'admin@test.com',
            'https://luminary.dev/roles': ['admin'],
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('admin@test.com');
    });

    it('shows access denied when /me fails and Auth0 roles are not admin', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        mockUser.value = {
            email: 'user@test.com',
            'https://luminary.dev/roles': ['user'],
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('Access denied');
    });
});
