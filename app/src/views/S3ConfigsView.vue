<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { listS3Configs, createS3Config, getS3Config, updateS3Config, deleteS3Config } from '../api';
import InlineConfirm from '../components/InlineConfirm.vue';

interface S3ConfigEntry {
    id: string;
    name: string;
    endPoint: string;
    port?: number;
    useSSL: boolean;
    bucket: string;
    region?: string;
    publicUrl?: string;
    createdAt: string;
}

interface S3ConfigForm {
    name: string;
    endPoint: string;
    port: number | undefined;
    useSSL: boolean;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    publicUrl: string;
}

const { getAccessTokenSilently } = useAuth0();

const configs = ref<S3ConfigEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const showForm = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const loadingConfig = ref(false);

const deleteConfirmId = ref<string | null>(null);
const deleting = ref(false);

function emptyForm(): S3ConfigForm {
    return {
        name: '',
        endPoint: '',
        port: undefined,
        useSSL: true,
        bucket: '',
        region: '',
        accessKey: '',
        secretKey: '',
        publicUrl: '',
    };
}

const form = reactive<S3ConfigForm>(emptyForm());

function resetForm() {
    Object.assign(form, emptyForm());
    formError.value = null;
}

async function fetchConfigs() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        configs.value = result.configs ?? [];
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

function openCreateForm() {
    resetForm();
    editingId.value = null;
    showForm.value = true;
}

async function openEditForm(configId: string) {
    resetForm();
    editingId.value = configId;
    showForm.value = true;
    loadingConfig.value = true;

    try {
        const token = await getAccessTokenSilently();
        const data = await getS3Config(token, configId);
        form.name = data.name || '';
        form.endPoint = data.endPoint || '';
        form.port = data.port;
        form.useSSL = data.useSSL !== false;
        form.bucket = data.bucket || '';
        form.region = data.region || '';
        form.publicUrl = data.publicUrl || '';
        // Credentials are shown as placeholders — only sent if user fills them in
        form.accessKey = '';
        form.secretKey = '';
    } catch (e) {
        formError.value = e instanceof Error ? e.message : String(e);
    } finally {
        loadingConfig.value = false;
    }
}

function closeForm() {
    showForm.value = false;
    editingId.value = null;
    resetForm();
}

function validateForm(): boolean {
    return !!(form.name.trim() && form.endPoint.trim() && form.bucket.trim());
}

async function handleSubmit() {
    if (!validateForm()) return;
    saving.value = true;
    formError.value = null;

    try {
        const token = await getAccessTokenSilently();

        const payload: Record<string, any> = {
            name: form.name.trim(),
            endPoint: form.endPoint.trim(),
            useSSL: form.useSSL,
            bucket: form.bucket.trim(),
        };

        if (form.port) payload.port = form.port;
        if (form.region.trim()) payload.region = form.region.trim();
        if (form.publicUrl.trim()) {
            payload.publicUrl = form.publicUrl.trim();
        } else if (editingId.value) {
            // Explicitly clear publicUrl when editing and field is empty
            payload.publicUrl = '';
        }

        if (editingId.value) {
            // Only send credentials if user entered new values
            if (form.accessKey.trim()) payload.accessKey = form.accessKey.trim();
            if (form.secretKey.trim()) payload.secretKey = form.secretKey.trim();
            await updateS3Config(token, editingId.value, payload);
        } else {
            // Creating — credentials are required
            payload.accessKey = form.accessKey.trim();
            payload.secretKey = form.secretKey.trim();
            await createS3Config(token, payload);
        }

        closeForm();
        await fetchConfigs();
    } catch (e) {
        formError.value = e instanceof Error ? e.message : String(e);
    } finally {
        saving.value = false;
    }
}

async function handleDelete(configId: string) {
    deleteConfirmId.value = configId;
    deleting.value = true;
    try {
        const token = await getAccessTokenSilently();
        await deleteS3Config(token, configId);
        await fetchConfigs();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        deleting.value = false;
        deleteConfirmId.value = null;
    }
}

function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

onMounted(fetchConfigs);
</script>

<template>
    <div class="max-w-4xl mx-auto">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-lg font-semibold text-zinc-100">S3 Configurations</h2>
                <button
                    v-if="!showForm"
                    @click="openCreateForm"
                    class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 cursor-pointer"
                >
                    Add Config
                </button>
            </div>

            <!-- Inline form -->
            <div v-if="showForm" class="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <h3 class="text-sm font-medium text-zinc-300 mb-4">
                    {{ editingId ? 'Edit Configuration' : 'New Configuration' }}
                </h3>

                <div v-if="loadingConfig" class="flex justify-center py-6">
                    <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                </div>

                <form v-else @submit.prevent="handleSubmit" class="space-y-4">
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500">Name</label>
                        <input v-model="form.name" type="text" class="input" placeholder="My S3 Config" />
                    </div>

                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div class="sm:col-span-2">
                            <label class="mb-1 block text-xs text-zinc-500">Endpoint</label>
                            <input v-model="form.endPoint" type="text" class="input" placeholder="s3.amazonaws.com" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Port</label>
                            <input v-model.number="form.port" type="number" class="input" placeholder="443" />
                        </div>
                        <div class="flex items-end pb-1">
                            <label class="flex items-center gap-2 text-sm">
                                <input type="checkbox" v-model="form.useSSL" class="accent-indigo-500" />
                                Use SSL
                            </label>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Bucket</label>
                            <input v-model="form.bucket" type="text" class="input" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Region</label>
                            <input v-model="form.region" type="text" class="input" placeholder="us-east-1" />
                        </div>
                    </div>

                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">
                                Access Key
                                <span v-if="editingId" class="text-zinc-600">(leave blank to keep current)</span>
                            </label>
                            <input
                                v-model="form.accessKey"
                                type="text"
                                autocomplete="new-password"
                                data-1p-ignore
                                data-lpignore="true"
                                class="input"
                                :placeholder="editingId ? '***' : ''"
                            />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">
                                Secret Key
                                <span v-if="editingId" class="text-zinc-600">(leave blank to keep current)</span>
                            </label>
                            <input
                                v-model="form.secretKey"
                                type="text"
                                autocomplete="new-password"
                                data-1p-ignore
                                data-lpignore="true"
                                class="input"
                                :placeholder="editingId ? '***' : ''"
                            />
                        </div>
                    </div>

                    <div>
                        <label class="mb-1 block text-xs text-zinc-500">
                            Public URL
                            <span class="text-zinc-600">(optional — for custom domains, e.g. Cloudflare R2)</span>
                        </label>
                        <input
                            v-model="form.publicUrl"
                            type="text"
                            class="input"
                            placeholder="https://media.example.com"
                        />
                    </div>

                    <div v-if="formError" class="rounded-lg bg-red-950/40 border border-red-800/50 p-3">
                        <p class="text-sm text-red-400">{{ formError }}</p>
                    </div>

                    <div class="flex gap-3">
                        <button
                            type="submit"
                            :disabled="!form.name.trim() || !form.endPoint.trim() || !form.bucket.trim() || saving || (!editingId && (!form.accessKey.trim() || !form.secretKey.trim()))"
                            :class="[
                                'rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
                                form.name.trim() && form.endPoint.trim() && form.bucket.trim() && !saving && (editingId || (form.accessKey.trim() && form.secretKey.trim()))
                                    ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                            ]"
                        >
                            {{ saving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
                        </button>
                        <button
                            type="button"
                            @click="closeForm"
                            class="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
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

            <!-- Configs list -->
            <div v-else-if="configs.length > 0" class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-zinc-800 text-left text-xs uppercase tracking-wider text-zinc-500">
                            <th class="pb-3 pr-4">Name</th>
                            <th class="pb-3 pr-4">Endpoint</th>
                            <th class="pb-3 pr-4">Bucket</th>
                            <th class="pb-3 pr-4">Created</th>
                            <th class="pb-3"></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="config in configs"
                            :key="config.id"
                            class="border-b border-zinc-800/50"
                        >
                            <td class="py-3 pr-4 text-zinc-200">{{ config.name }}</td>
                            <td class="py-3 pr-4 text-zinc-400 font-mono text-xs">
                                {{ config.endPoint }}{{ config.port ? `:${config.port}` : '' }}
                            </td>
                            <td class="py-3 pr-4 text-zinc-400">{{ config.bucket }}</td>
                            <td class="py-3 pr-4 text-zinc-400">{{ formatDate(config.createdAt) }}</td>
                            <td class="py-3 text-right">
                                <div class="flex items-center justify-end gap-2">
                                    <button
                                        @click="openEditForm(config.id)"
                                        class="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                                    >
                                        Edit
                                    </button>
                                    <InlineConfirm
                                        label="Delete"
                                        prompt="Delete?"
                                        :loading="deleting && deleteConfirmId === config.id"
                                        @confirm="() => handleDelete(config.id)"
                                    />
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <!-- Empty state -->
            <div v-else class="py-8 text-center text-sm text-zinc-500">
                No S3 configurations yet. Add one to get started.
            </div>
        </div>
    </div>
</template>
