<script setup lang="ts">
import { ref, inject, onMounted, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import {
    getUser,
    disableUser,
    enableUser,
    deleteUser,
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

function formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
}

onMounted(fetchUser);
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

            <!-- Placeholder sections -->
            <div class="mt-8 space-y-4">
                <div
                    class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center"
                >
                    <p class="text-sm text-zinc-500">
                        Sessions — Coming in a later phase
                    </p>
                </div>
                <div
                    class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center"
                >
                    <p class="text-sm text-zinc-500">
                        API Keys — Coming in a later phase
                    </p>
                </div>
            </div>
        </div>
    </div>
</template>
