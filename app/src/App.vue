<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { checkIdentity } from './api';

const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently, user } = useAuth0();
const returnTo = window.location.origin;

const identityChecked = ref(false);
const identityError = ref<string | null>(null);

watch(isAuthenticated, async (authenticated) => {
    if (!authenticated) {
        identityChecked.value = false;
        identityError.value = null;
        return;
    }
    try {
        const token = await getAccessTokenSilently();
        await checkIdentity(token);
        identityChecked.value = true;
    } catch (e) {
        identityError.value = e instanceof Error ? e.message : String(e);
    }
}, { immediate: true });
</script>

<template>
    <div class="px-4 py-12">
        <header class="mb-8 text-center">
            <h1 class="text-2xl font-bold tracking-tight text-zinc-100">Luminary Media Convert</h1>
            <p class="mt-1 text-sm text-zinc-500">HLS / ABR encoding client</p>
        </header>

        <!-- Loading state while Auth0 initializes or identity check runs -->
        <div v-if="isLoading || (isAuthenticated && !identityChecked && !identityError)" class="mx-auto max-w-2xl flex justify-center py-16">
            <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <!-- Login prompt -->
        <div v-else-if="!isAuthenticated" class="mx-auto max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur text-center">
            <p class="mb-4 text-sm text-zinc-400">Sign in to start an encoding session.</p>
            <button
                @click="loginWithRedirect()"
                class="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 cursor-pointer"
            >
                Sign In
            </button>
        </div>

        <!-- Identity check failed (disabled, not provisioned, etc.) -->
        <div v-else-if="identityError" class="mx-auto max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur text-center">
            <p class="mb-4 text-sm text-red-400">{{ identityError }}</p>
            <button
                @click="logout({ logoutParams: { returnTo } })"
                class="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer"
            >
                Sign Out
            </button>
        </div>

        <!-- Authenticated content -->
        <template v-else>
            <!-- User bar -->
            <div class="mx-auto max-w-4xl mb-4 flex items-center justify-between text-sm text-zinc-400">
                <nav class="flex items-center gap-4">
                    <router-link
                        to="/"
                        :class="[
                            'transition-colors hover:text-zinc-200',
                            $route.path === '/' ? 'text-indigo-400 font-medium' : 'text-zinc-400',
                        ]"
                    >
                        Encode
                    </router-link>
                    <router-link
                        to="/keys"
                        :class="[
                            'transition-colors hover:text-zinc-200',
                            $route.path === '/keys' ? 'text-indigo-400 font-medium' : 'text-zinc-400',
                        ]"
                    >
                        API Keys
                    </router-link>
                    <router-link
                        to="/s3-configs"
                        :class="[
                            'transition-colors hover:text-zinc-200',
                            $route.path === '/s3-configs' ? 'text-indigo-400 font-medium' : 'text-zinc-400',
                        ]"
                    >
                        S3 Configs
                    </router-link>
                </nav>
                <div class="flex items-center gap-3">
                    <span>{{ user?.email }}</span>
                    <button
                        @click="logout({ logoutParams: { returnTo } })"
                        class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                    >
                        Sign Out
                    </button>
                </div>
            </div>

            <router-view />
        </template>
    </div>
</template>
