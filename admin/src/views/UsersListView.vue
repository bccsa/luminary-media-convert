<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import {
    listUsers,
    disableUser,
    enableUser,
    deleteUser,
} from '../api';

const router = useRouter();
const { getAccessTokenSilently } = useAuth0();

interface User {
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    createdAt: string;
}

const users = ref<User[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const skip = ref(0);
const limit = 25;
const total = ref(0);

let searchTimeout: ReturnType<typeof setTimeout> | null = null;

watch(search, () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        skip.value = 0;
        fetchUsers();
    }, 300);
});

async function fetchUsers() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listUsers(token, {
            limit,
            skip: skip.value,
            search: search.value || undefined,
        });
        users.value = result.users ?? result.data ?? result ?? [];
        total.value = result.total ?? users.value.length;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

async function onDisable(userId: string) {
    if (!confirm('Disable this user?')) return;
    try {
        const token = await getAccessTokenSilently();
        await disableUser(token, userId);
        await fetchUsers();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

async function onEnable(userId: string) {
    try {
        const token = await getAccessTokenSilently();
        await enableUser(token, userId);
        await fetchUsers();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

async function onDelete(userId: string) {
    if (!confirm('Permanently delete this user? This cannot be undone.'))
        return;
    try {
        const token = await getAccessTokenSilently();
        await deleteUser(token, userId);
        await fetchUsers();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    }
}

function prevPage() {
    skip.value = Math.max(0, skip.value - limit);
    fetchUsers();
}

function nextPage() {
    skip.value += limit;
    fetchUsers();
}

function formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString();
}

onMounted(fetchUsers);
</script>

<template>
    <div>
        <div class="mb-6 flex items-center justify-between">
            <h2 class="text-xl font-semibold text-zinc-100">Users</h2>
            <router-link
                to="/users/new"
                class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
            >
                Create User
            </router-link>
        </div>

        <!-- Search -->
        <div class="mb-4">
            <input
                v-model="search"
                type="text"
                placeholder="Search by email or name..."
                class="w-full max-w-sm rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
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

        <!-- Table -->
        <div
            v-else
            class="overflow-hidden rounded-lg border border-zinc-800"
        >
            <table class="w-full text-sm text-left">
                <thead
                    class="border-b border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500"
                >
                    <tr>
                        <th class="px-4 py-3">Email</th>
                        <th class="px-4 py-3">Name</th>
                        <th class="px-4 py-3">Role</th>
                        <th class="px-4 py-3">Status</th>
                        <th class="px-4 py-3">Created</th>
                        <th class="px-4 py-3 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="text-zinc-300">
                    <tr
                        v-for="u in users"
                        :key="u.id"
                        class="border-b border-zinc-800/50 transition-colors hover:bg-zinc-900/30 cursor-pointer"
                        @click="router.push(`/users/${u.id}`)"
                    >
                        <td class="px-4 py-3">{{ u.email }}</td>
                        <td class="px-4 py-3">{{ u.name }}</td>
                        <td class="px-4 py-3">
                            <span
                                :class="[
                                    'rounded-full px-2 py-0.5 text-xs font-medium',
                                    u.role === 'admin'
                                        ? 'bg-indigo-900/40 text-indigo-300'
                                        : 'bg-zinc-800 text-zinc-400',
                                ]"
                            >
                                {{ u.role }}
                            </span>
                        </td>
                        <td class="px-4 py-3">
                            <span
                                :class="[
                                    'rounded-full px-2 py-0.5 text-xs font-medium',
                                    u.status === 'active'
                                        ? 'bg-green-900/40 text-green-400'
                                        : 'bg-red-900/40 text-red-400',
                                ]"
                            >
                                {{ u.status }}
                            </span>
                        </td>
                        <td class="px-4 py-3 text-zinc-500">
                            {{ formatDate(u.createdAt) }}
                        </td>
                        <td
                            class="px-4 py-3 text-right"
                            @click.stop
                        >
                            <div class="flex justify-end gap-2">
                                <button
                                    v-if="u.status === 'active'"
                                    @click="onDisable(u.id)"
                                    class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-amber-700 hover:text-amber-400 cursor-pointer"
                                >
                                    Disable
                                </button>
                                <button
                                    v-else
                                    @click="onEnable(u.id)"
                                    class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-green-700 hover:text-green-400 cursor-pointer"
                                >
                                    Enable
                                </button>
                                <button
                                    @click="onDelete(u.id)"
                                    class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-red-700 hover:text-red-400 cursor-pointer"
                                >
                                    Delete
                                </button>
                            </div>
                        </td>
                    </tr>
                    <tr v-if="users.length === 0">
                        <td
                            colspan="6"
                            class="px-4 py-8 text-center text-zinc-500"
                        >
                            No users found.
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Pagination -->
        <div
            v-if="!loading && total > limit"
            class="mt-4 flex items-center justify-between text-sm text-zinc-500"
        >
            <span>
                Showing {{ skip + 1 }}&ndash;{{
                    Math.min(skip + limit, total)
                }}
                of {{ total }}
            </span>
            <div class="flex gap-2">
                <button
                    :disabled="skip === 0"
                    @click="prevPage"
                    class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                    Previous
                </button>
                <button
                    :disabled="skip + limit >= total"
                    @click="nextPage"
                    class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                    Next
                </button>
            </div>
        </div>
    </div>
</template>
