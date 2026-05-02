<script setup lang="ts">
import { ref, computed, inject, onMounted, type Ref } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { createApiKey, listApiKeys, revokeApiKey } from '../api';
import InlineConfirm from '../components/InlineConfirm.vue';

const encodingApiUrl = inject<Ref<string>>('encodingApiUrl', ref(''));
const docsUrl = computed(() => encodingApiUrl.value ? `${encodingApiUrl.value}/api/docs` : '');
const showDocs = ref(false);

interface ApiKey {
    id: string;
    name: string;
    prefix: string;
    status: 'active' | 'revoked';
    lastUsedAt: string | null;
    createdAt: string;
}

const { getAccessTokenSilently } = useAuth0();

const keys = ref<ApiKey[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const newKeyName = ref('');
const creating = ref(false);
const createError = ref<string | null>(null);
const createdKey = ref<string | null>(null);
const copiedKey = ref(false);

const revokeConfirmId = ref<string | null>(null);
const revoking = ref(false);

async function fetchKeys() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        keys.value = await listApiKeys(token);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

async function handleCreate() {
    if (!newKeyName.value.trim()) return;
    creating.value = true;
    createError.value = null;
    createdKey.value = null;
    copiedKey.value = false;
    try {
        const token = await getAccessTokenSilently();
        const result = await createApiKey(token, newKeyName.value.trim());
        createdKey.value = result.key;
        newKeyName.value = '';
        await fetchKeys();
    } catch (e) {
        createError.value = e instanceof Error ? e.message : String(e);
    } finally {
        creating.value = false;
    }
}

async function copyKey() {
    if (!createdKey.value) return;
    await navigator.clipboard.writeText(createdKey.value);
    copiedKey.value = true;
    setTimeout(() => { copiedKey.value = false; }, 2000);
}

async function handleRevoke(keyId: string) {
    revokeConfirmId.value = keyId;
    revoking.value = true;
    try {
        const token = await getAccessTokenSilently();
        await revokeApiKey(token, keyId);
        await fetchKeys();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        revoking.value = false;
        revokeConfirmId.value = null;
    }
}

function formatDate(dateStr: string | null): string {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

onMounted(fetchKeys);
</script>

<template>
    <div class="app-view">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <h2 class="text-lg font-semibold text-zinc-100 mb-4">API Keys</h2>

            <!-- Help text -->
            <div class="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
                <p class="text-sm text-zinc-400">
                    API keys allow direct access to the Encoding API from third-party tools, scripts, or services.
                    Pass the key in the <code class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-indigo-400">X-API-Key</code> header with each request.
                </p>
                <div v-if="encodingApiUrl" class="space-y-2">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-zinc-500">Encoding API:</span>
                        <code class="rounded bg-zinc-800 px-2 py-1 text-xs font-mono text-zinc-200">{{ encodingApiUrl }}</code>
                    </div>
                    <div v-if="docsUrl" class="flex items-center gap-2">
                        <span class="text-xs text-zinc-500">API Documentation:</span>
                        <a
                            :href="docsUrl"
                            target="_blank"
                            rel="noopener"
                            class="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                            {{ docsUrl }}
                        </a>
                        <button
                            type="button"
                            class="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer transition-colors"
                            @click="showDocs = !showDocs"
                        >
                            {{ showDocs ? 'Hide' : 'Show' }} docs
                        </button>
                    </div>
                </div>
                <p class="text-xs text-zinc-500">
                    Keys are generated in your browser and only the hash is stored on the server.
                    The raw key is shown once at creation — store it securely.
                </p>
            </div>

            <!-- Embedded Swagger docs -->
            <div v-if="showDocs && docsUrl" class="mb-6 rounded-lg border border-zinc-800 overflow-hidden">
                <iframe
                    :src="docsUrl"
                    class="w-full border-0 bg-white"
                    style="height: 600px"
                    title="Encoding API Documentation"
                />
            </div>

            <!-- Create Key -->
            <div class="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <h3 class="text-sm font-medium text-zinc-300 mb-3">Create Key</h3>
                <form @submit.prevent="handleCreate" class="flex gap-3">
                    <input
                        v-model="newKeyName"
                        type="text"
                        placeholder="Key name"
                        class="input flex-1"
                        :disabled="creating"
                    />
                    <button
                        type="submit"
                        :disabled="!newKeyName.trim() || creating"
                        :class="[
                            'rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap',
                            newKeyName.trim() && !creating
                                ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                        ]"
                    >
                        {{ creating ? 'Creating...' : 'Create Key' }}
                    </button>
                </form>

                <div v-if="createError" class="mt-3 rounded-lg bg-red-950/40 border border-red-800/50 p-3">
                    <p class="text-sm text-red-400">{{ createError }}</p>
                </div>

                <div v-if="createdKey" class="mt-3 rounded-lg bg-emerald-950/40 border border-emerald-800/50 p-4">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-sm font-medium text-emerald-400">Key created successfully</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <code class="flex-1 rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 font-mono break-all select-all">{{ createdKey }}</code>
                        <button
                            @click="copyKey"
                            class="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer whitespace-nowrap"
                        >
                            {{ copiedKey ? 'Copied!' : 'Copy' }}
                        </button>
                    </div>
                    <p class="mt-2 text-xs text-amber-400">This key will not be shown again. Store it securely.</p>
                </div>
            </div>

            <!-- Loading -->
            <div v-if="loading" class="flex justify-center py-8">
                <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>

            <!-- Error -->
            <div v-else-if="error" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                <p class="text-sm text-red-400">{{ error }}</p>
            </div>

            <!-- Keys table -->
            <div v-else-if="keys.length > 0" class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-zinc-800 text-left text-xs uppercase tracking-wider text-zinc-500">
                            <th class="pb-3 pr-4">Name</th>
                            <th class="pb-3 pr-4">Prefix</th>
                            <th class="pb-3 pr-4">Status</th>
                            <th class="pb-3 pr-4">Last Used</th>
                            <th class="pb-3 pr-4">Created</th>
                            <th class="pb-3"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="key in keys"
                            :key="key.id"
                            class="border-b border-zinc-800/50"
                        >
                            <td class="py-3 pr-4 text-zinc-200">{{ key.name }}</td>
                            <td class="py-3 pr-4 font-mono text-zinc-400">{{ key.prefix }}...</td>
                            <td class="py-3 pr-4">
                                <span
                                    :class="[
                                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                                        key.status === 'active'
                                            ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-800/50'
                                            : 'bg-zinc-800 text-zinc-500 border border-zinc-700',
                                    ]"
                                >
                                    {{ key.status }}
                                </span>
                            </td>
                            <td class="py-3 pr-4 text-zinc-400">{{ formatDate(key.lastUsedAt) }}</td>
                            <td class="py-3 pr-4 text-zinc-400">{{ formatDate(key.createdAt) }}</td>
                            <td class="py-3 text-right">
                                <div v-if="key.status === 'active'" class="flex items-center justify-end gap-2">
                                    <InlineConfirm
                                        label="Revoke"
                                        prompt="Revoke?"
                                        confirm-label="Yes"
                                        :loading="revoking && revokeConfirmId === key.id"
                                        loading-label="Revoking..."
                                        @confirm="() => handleRevoke(key.id)"
                                    />
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Empty state -->
            <div v-else class="py-8 text-center text-sm text-zinc-500">
                No API keys yet. Create one above to get started.
            </div>
        </div>
    </div>
</template>
