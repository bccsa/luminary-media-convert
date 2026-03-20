<script setup lang="ts">
import { ref, inject, onMounted, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import {
    getUser,
    disableUser,
    enableUser,
    deleteUser,
    listUserKeys,
    revokeUserKey,
} from '../api';

const currentUserId = inject<Ref<string | null>>('currentUserId');
const isSelf = () => currentUserId?.value === userId;

const route = useRoute();
const router = useRouter();
const { getAccessTokenSilently } = useAuth0();

interface User {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    lastLoginAt: string | null;
    lastApiAccessAt: string | null;
    createdAt: string;
    updatedAt: string;
}

const user = ref<User | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const userId = route.params.id as string;

async function fetchUser() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        user.value = await getUser(token, userId);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

async function onDisable() {
    if (!confirm('Disable this user?')) return;
    try {
        const token = await getAccessTokenSilently();
        await disableUser(token, userId);
        await fetchUser();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

async function onEnable() {
    try {
        const token = await getAccessTokenSilently();
        await enableUser(token, userId);
        await fetchUser();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

async function onDelete() {
    if (!confirm('Permanently delete this user? This cannot be undone.'))
        return;
    try {
        const token = await getAccessTokenSilently();
        await deleteUser(token, userId);
        router.push('/users');
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

interface ApiKey {
    id: string;
    name: string;
    prefix: string;
    status: 'active' | 'revoked';
    lastUsedAt: string | null;
    createdAt: string;
}

const keys = ref<ApiKey[]>([]);
const keysLoading = ref(false);

async function fetchKeys() {
    keysLoading.value = true;
    try {
        const token = await getAccessTokenSilently();
        const result = await listUserKeys(token, userId);
        keys.value = result.keys ?? [];
    } catch {
        // Non-critical — just show empty
        keys.value = [];
    } finally {
        keysLoading.value = false;
    }
}

async function onRevokeKey(keyId: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
        const token = await getAccessTokenSilently();
        await revokeUserKey(token, userId, keyId);
        await fetchKeys();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

function formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
}

onMounted(() => {
    fetchUser();
    fetchKeys();
});
</script>

<template>
    <div>
        <div class="mb-6">
            <router-link
                to="/users"
                class="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
            >
                &larr; Back to Users
            </router-link>
        </div>

        <!-- Error -->
        <div
            v-if="error"
            class="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4"
        >
            <p class="text-sm text-red-400">{{ error }}</p>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex justify-center py-16">
            <svg
                class="h-6 w-6 animate-spin text-indigo-400"
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

        <!-- User detail -->
        <div v-else-if="user">
            <div class="mb-6 flex items-start justify-between">
                <div>
                    <h2 class="text-xl font-semibold text-zinc-100">
                        {{ user.name }}
                    </h2>
                    <p class="text-sm text-zinc-500">{{ user.email }}</p>
                </div>
                <div class="flex gap-2">
                    <router-link
                        :to="`/users/${user.id}/edit`"
                        class="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                    >
                        Edit
                    </router-link>
                    <button
                        v-if="user.status === 'active' && !isSelf()"
                        @click="onDisable"
                        class="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-amber-700 hover:text-amber-400 cursor-pointer"
                    >
                        Disable
                    </button>
                    <button
                        v-else-if="user.status !== 'active'"
                        @click="onEnable"
                        class="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-green-700 hover:text-green-400 cursor-pointer"
                    >
                        Enable
                    </button>
                    <button
                        v-if="!isSelf()"
                        @click="onDelete"
                        class="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-red-700 hover:text-red-400 cursor-pointer"
                    >
                        Delete
                    </button>
                </div>
            </div>

            <div
                class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6"
            >
                <dl class="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <dt class="text-zinc-500">Role</dt>
                        <dd class="mt-1 text-zinc-100">
                            <span
                                :class="[
                                    'rounded-full px-2 py-0.5 text-xs font-medium',
                                    user.role === 'admin'
                                        ? 'bg-indigo-900/40 text-indigo-300'
                                        : 'bg-zinc-800 text-zinc-400',
                                ]"
                            >
                                {{ user.role }}
                            </span>
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Status</dt>
                        <dd class="mt-1 text-zinc-100">
                            <span
                                :class="[
                                    'rounded-full px-2 py-0.5 text-xs font-medium',
                                    user.status === 'active'
                                        ? 'bg-green-900/40 text-green-400'
                                        : 'bg-red-900/40 text-red-400',
                                ]"
                            >
                                {{ user.status }}
                            </span>
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Last Login</dt>
                        <dd class="mt-1 text-zinc-100">
                            {{ formatDate(user.lastLoginAt) }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Last API Access</dt>
                        <dd class="mt-1 text-zinc-100">
                            {{ formatDate(user.lastApiAccessAt) }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Created</dt>
                        <dd class="mt-1 text-zinc-100">
                            {{ formatDate(user.createdAt) }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Updated</dt>
                        <dd class="mt-1 text-zinc-100">
                            {{ formatDate(user.updatedAt) }}
                        </dd>
                    </div>
                </dl>
            </div>

            <!-- Sessions link -->
            <div class="mt-8">
                <router-link
                    :to="`/sessions?userId=${userId}`"
                    class="block rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
                >
                    View sessions &rarr;
                </router-link>
            </div>

            <!-- API Keys -->
            <div class="mt-6">
                <h3 class="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-400">
                    API Keys
                    <span v-if="keys.length" class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-500">
                        {{ keys.length }}
                    </span>
                </h3>

                <div v-if="keysLoading" class="flex justify-center py-8">
                    <svg class="h-5 w-5 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                </div>

                <div v-else-if="keys.length === 0" class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
                    <p class="text-sm text-zinc-500">No API keys</p>
                </div>

                <div v-else class="overflow-hidden rounded-lg border border-zinc-800">
                    <table class="w-full text-sm text-left">
                        <thead class="border-b border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500">
                            <tr>
                                <th class="px-4 py-3">Name</th>
                                <th class="px-4 py-3">Prefix</th>
                                <th class="px-4 py-3">Status</th>
                                <th class="px-4 py-3">Last Used</th>
                                <th class="px-4 py-3">Created</th>
                                <th class="px-4 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody class="text-zinc-300">
                            <tr
                                v-for="key in keys"
                                :key="key.id"
                                class="border-b border-zinc-800/50"
                            >
                                <td class="px-4 py-3">{{ key.name }}</td>
                                <td class="px-4 py-3 font-mono text-xs text-zinc-500">{{ key.prefix }}...</td>
                                <td class="px-4 py-3">
                                    <span
                                        :class="[
                                            'rounded-full px-2 py-0.5 text-xs font-medium',
                                            key.status === 'active'
                                                ? 'bg-green-900/40 text-green-400'
                                                : 'bg-red-900/40 text-red-400',
                                        ]"
                                    >
                                        {{ key.status }}
                                    </span>
                                </td>
                                <td class="px-4 py-3 text-zinc-500">{{ formatDate(key.lastUsedAt) }}</td>
                                <td class="px-4 py-3 text-zinc-500">{{ formatDate(key.createdAt) }}</td>
                                <td class="px-4 py-3 text-right">
                                    <button
                                        v-if="key.status === 'active'"
                                        @click="onRevokeKey(key.id)"
                                        class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-red-700 hover:text-red-400 cursor-pointer"
                                    >
                                        Revoke
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</template>
