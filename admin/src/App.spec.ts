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
            [`${import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE}/roles`]: ['admin'],
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
            [`${import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE}/roles`]: ['user'],
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('Access denied');
    });

    it('calls logout from access denied screen', async () => {
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
        const signOutBtn = wrapper.findAll('button').find(b => b.text() === 'Sign Out');
        await signOutBtn!.trigger('click');
        expect(mockLogout).toHaveBeenCalled();
    });

    it('calls logout from admin header', async () => {
        mockGetCurrentUser.mockResolvedValue({
            id: 'u1',
            email: 'admin@test.com',
            role: 'admin',
        });
        mockUser.value = { email: 'admin@test.com' };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        const signOutBtn = wrapper.findAll('button').find(b => b.text() === 'Sign Out');
        await signOutBtn!.trigger('click');
        expect(mockLogout).toHaveBeenCalled();
    });

    it('shows access denied when /me fails and no Auth0 roles claim', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        mockUser.value = {
            email: 'user@test.com',
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('Access denied');
    });

    it('handles me response without id field', async () => {
        mockGetCurrentUser.mockResolvedValue({
            email: 'admin@test.com',
            role: 'admin',
        });
        mockUser.value = { email: 'admin@test.com' };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        // Should still show admin content even without id
        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);
    });

    it('falls back without namespace in Auth0 claims', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        // When VITE_AUTH0_CLAIM_NAMESPACE is set, the code tries namespace/roles first,
        // then falls back to the bare 'roles' claim
        const namespace = import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE;
        mockUser.value = {
            email: 'admin@test.com',
            ...(namespace
                ? { [`${namespace}/roles`]: undefined }
                : {}),
            roles: ['admin'],
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        // Falls back to roles directly
        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);
    });

    it('uses namespace claim when VITE_AUTH0_CLAIM_NAMESPACE is configured', async () => {
        const origNamespace = import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE;
        // Temporarily set a namespace
        import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE = 'https://test.example.com';

        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        mockUser.value = {
            email: 'admin@test.com',
            'https://test.example.com/roles': ['admin'],
        };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);

        // Restore original
        if (origNamespace !== undefined) {
            import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE = origNamespace;
        } else {
            delete import.meta.env.VITE_AUTH0_CLAIM_NAMESPACE;
        }
    });

    it('handles /me failure with null user value', async () => {
        mockGetCurrentUser.mockRejectedValue(new Error('Not found'));
        mockUser.value = undefined;
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.text()).toContain('Access denied');
    });

    it('resets admin state when user logs out', async () => {
        mockGetCurrentUser.mockResolvedValue({
            id: 'u1',
            email: 'admin@test.com',
            role: 'admin',
        });
        mockUser.value = { email: 'admin@test.com' };
        mockIsAuthenticated.value = true;

        const wrapper = mountApp();
        await flushPromises();

        expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true);

        // Simulate logout
        mockIsAuthenticated.value = false;
        await flushPromises();

        expect(wrapper.text()).toContain('Sign In');
    });
});
