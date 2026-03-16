<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { getCurrentUser } from './api';

const {
    isAuthenticated,
    isLoading,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
    user,
} = useAuth0();
const returnTo = window.location.origin;

const isAdmin = ref(false);
const adminCheckLoading = ref(false);
const adminCheckError = ref<string | null>(null);

watch(isAuthenticated, async (authenticated) => {
    if (!authenticated) {
        isAdmin.value = false;
        return;
    }
    adminCheckLoading.value = true;
    adminCheckError.value = null;
    try {
        const token = await getAccessTokenSilently();
        const me = await getCurrentUser(token);
        isAdmin.value = me?.role === 'admin';
        if (!isAdmin.value) {
            adminCheckError.value = 'Access denied — admin role required';
        }
    } catch {
        // /me endpoint may not exist yet — fall back to Auth0 user metadata
        const roles =
            (user.value as Record<string, unknown>)?.[
                'https://luminary.dev/roles'
            ] ??
            (user.value as Record<string, unknown>)?.['roles'];
        if (Array.isArray(roles) && roles.includes('admin')) {
            isAdmin.value = true;
        } else {
            isAdmin.value = false;
            adminCheckError.value =
                'Access denied — admin role required';
        }
    } finally {
        adminCheckLoading.value = false;
    }
}, { immediate: true });
</script>

<template>
    <div class="min-h-screen">
        <!-- Loading state while Auth0 initializes -->
        <div
            v-if="isLoading || adminCheckLoading"
            class="flex items-center justify-center py-32"
        >
            <svg
                class="h-8 w-8 animate-spin text-indigo-400"
                fill="none"
                viewBox="0 0 24 24"
            >
                <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                />
                <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
            </svg>
        </div>

        <!-- Login prompt -->
        <div
            v-else-if="!isAuthenticated"
            class="mx-auto max-w-md px-4 py-32 text-center"
        >
            <h1
                class="mb-2 text-2xl font-bold tracking-tight text-zinc-100"
            >
                Luminary Admin
            </h1>
            <p class="mb-6 text-sm text-zinc-500">
                Sign in to access the admin panel.
            </p>
            <button
                @click="loginWithRedirect()"
                class="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 cursor-pointer"
            >
                Sign In
            </button>
        </div>

        <!-- Access denied -->
        <div
            v-else-if="adminCheckError"
            class="mx-auto max-w-md px-4 py-32 text-center"
        >
            <h1
                class="mb-2 text-2xl font-bold tracking-tight text-zinc-100"
            >
                Luminary Admin
            </h1>
            <p class="mb-6 text-sm text-red-400">{{ adminCheckError }}</p>
            <button
                @click="logout({ logoutParams: { returnTo } })"
                class="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer"
            >
                Sign Out
            </button>
        </div>

        <!-- Authenticated admin content -->
        <template v-else>
            <header
                class="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur"
            >
                <div
                    class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3"
                >
                    <div class="flex items-center gap-6">
                        <h1
                            class="text-sm font-bold tracking-tight text-zinc-100"
                        >
                            Luminary Admin
                        </h1>
                        <nav class="flex gap-4 text-sm">
                            <router-link
                                to="/"
                                class="text-zinc-400 transition-colors hover:text-zinc-200"
                            >
                                Dashboard
                            </router-link>
                            <router-link
                                to="/users"
                                class="text-zinc-400 transition-colors hover:text-zinc-200"
                            >
                                Users
                            </router-link>
                        </nav>
                    </div>
                    <div
                        class="flex items-center gap-3 text-sm text-zinc-400"
                    >
                        <span>{{ user?.email }}</span>
                        <button
                            @click="
                                logout({ logoutParams: { returnTo } })
                            "
                            class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                        >
                            Sign Out
                        </button>
                    </div>
                </div>
            </header>

            <main class="mx-auto max-w-6xl px-6 py-8">
                <router-view />
            </main>
        </template>
    </div>
</template>
