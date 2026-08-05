/**
 * Stands in for `@auth0/auth0-vue` in the desktop build.
 *
 * The desktop app runs entirely on the user's own machine: the encoder is a
 * local process, the API is served from the same loopback origin as the app,
 * and there is no tenant to belong to. There is nothing to authenticate, so
 * rather than unpick `useAuth0()` from eight components this is aliased in at
 * build time and every call site keeps compiling unchanged.
 *
 * Signing in is reported as already done. `App.vue` gates its whole shell on
 * `isAuthenticated` and `isLoading`, so returning true and false from the first
 * tick means its three signed-out branches simply never render — no edits to a
 * file with four render states and non-trivial layout logic.
 *
 * The token is a placeholder. Every function in `api.ts` takes one and sends it
 * as a bearer header; the local adapter ignores it, because a token that
 * authenticates nobody to a service with one user is theatre.
 *
 * The shape here mirrors the mock that `SessionView.spec.ts` has always used.
 */

import { computed, ref } from 'vue';

const LOCAL_USER = {
    name: 'Local',
    email: 'local@localhost',
};

const isAuthenticated = ref(true);
const isLoading = ref(false);
const user = ref(LOCAL_USER);
const error = ref(null);

async function getAccessTokenSilently(): Promise<string> {
    return 'local';
}

async function getAccessTokenWithPopup(): Promise<string> {
    return 'local';
}

/** Nothing to redirect to — the app is already showing everything it has. */
function loginWithRedirect(): Promise<void> {
    return Promise.resolve();
}

/**
 * Signing out of a local app would leave the user staring at a login screen
 * they cannot get past. Deliberately inert; the desktop build hides the
 * control that calls it.
 */
function logout(): Promise<void> {
    return Promise.resolve();
}

export function useAuth0() {
    return {
        isAuthenticated,
        isLoading,
        user,
        error,
        idTokenClaims: computed(() => undefined),
        getAccessTokenSilently,
        getAccessTokenWithPopup,
        loginWithRedirect,
        logout,
        checkSession: async () => {},
        handleRedirectCallback: async () => ({}),
    };
}

/**
 * A no-op Vue plugin, so `main.ts` needs no change at all — it keeps calling
 * `app.use(createAuth0({...}))` and that simply installs nothing.
 */
export function createAuth0(_options?: unknown) {
    return {
        install() {},
    };
}

export const authGuard = () => true;
