<script setup lang="ts">
import FormSelect from '../FormSelect.vue';

const props = defineProps<{
    isCompleted: boolean;
    /** true when status is completed | failed | imported — shows delete option */
    isTerminal: boolean;
    currentStatus: string | null;
    displayMasterPlaylist?: string;
    s3Url: string | null;
    copied: boolean;
    isEncrypted: boolean;
    encryptionKeyHex?: string;
    copiedKey: boolean;
    displayFiles?: string[];
    shouldCollapseFiles: boolean;
    session: Record<string, any> | null;
    hasS3Files: boolean;
    showMoveForm: boolean;
    showRenameForm: boolean;
    moveTargetS3SelectOptions: { value: string; label: string }[];
    movePrefixWarning: string | null;
    moveError: string | null;
    canMove: boolean;
    moving: boolean;
    renamePrefixWarning: string | null;
    renameError: string | null;
    canRename: boolean;
    renaming: boolean;
}>();

const showFiles = defineModel<boolean>('showFiles', { required: true });
const selectedTargetConfigId = defineModel<string>('selectedTargetConfigId', { required: true });
const moveNewPrefix = defineModel<string>('moveNewPrefix', { required: true });
const moveConfirmedOverwrite = defineModel<boolean>('moveConfirmedOverwrite', { required: true });
const renameNewPrefix = defineModel<string>('renameNewPrefix', { required: true });
const renameConfirmedOverwrite = defineModel<boolean>('renameConfirmedOverwrite', { required: true });

const emit = defineEmits<{
    copyPlaybackUrl: [];
    copyEncryptionKey: [];
    copyOutputObjectKey: [key: string];
    openMoveForm: [];
    openRenameForm: [];
    checkMovePrefix: [];
    confirmMove: [];
    cancelMove: [];
    checkRenamePrefix: [];
    confirmRename: [];
    cancelRename: [];
    deleteSession: [];
}>();

function inferOutputFileKind(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.m3u8')) return 'HLS playlist';
    if (lower.endsWith('.ts')) return 'MPEG-TS';
    if (lower.endsWith('.m4s')) return 'fMP4 media';
    if (lower.endsWith('.mp4')) return 'MP4';
    if (lower.endsWith('.vtt')) return 'WebVTT';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) return 'Image';
    return 'Object';
}

function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}
</script>

<template>
    <div class="space-y-5">
        <p v-if="!isCompleted && currentStatus !== 'failed'" class="text-sm text-slate-500 dark:text-slate-400">
            When the package completes, this tab lists output keys, URLs, prefix tools, and delete options.
        </p>
        <p v-else-if="currentStatus === 'failed'" class="text-sm text-slate-500 dark:text-slate-400">
            Encoding did not complete. See the Workflow tab for the error detail.
        </p>

        <template v-if="isCompleted">
            <div v-if="displayMasterPlaylist" class="rounded-xl border border-slate-200 bg-slate-50/95 p-4 dark:border-slate-700 dark:bg-slate-800/60">
                <div class="mb-2 flex items-center justify-between gap-2">
                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Master playlist</p>
                    <button
                        v-if="s3Url"
                        type="button"
                        class="cursor-pointer rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium transition-colors"
                        :class="copied ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15' : 'bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'"
                        @click="emit('copyPlaybackUrl')"
                    >
                        {{ copied ? 'Copied' : 'Copy URL' }}
                    </button>
                </div>
                <p class="break-all font-mono text-sm text-slate-700 dark:text-slate-400">{{ s3Url ?? displayMasterPlaylist }}</p>
            </div>

            <div v-if="isEncrypted && encryptionKeyHex" class="rounded-xl border border-slate-200 bg-slate-50/95 p-4 dark:border-slate-700 dark:bg-slate-800/60">
                <div class="mb-2 flex items-center justify-between gap-2">
                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Encryption key</p>
                    <button
                        type="button"
                        class="cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
                        :class="copiedKey ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40' : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800'"
                        @click="emit('copyEncryptionKey')"
                    >
                        {{ copiedKey ? 'Copied' : 'Copy key' }}
                    </button>
                </div>
                <code class="block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-amber-800 dark:bg-slate-800 dark:text-amber-400">{{ encryptionKeyHex }}</code>
            </div>

            <details
                v-if="displayFiles?.length"
                class="group rounded-xl border border-slate-200 bg-slate-50/95 dark:border-slate-700 dark:bg-slate-800/60"
            >
                <summary
                    class="flex cursor-pointer list-none items-center gap-2 rounded-xl p-4 text-left [&::-webkit-details-marker]:hidden"
                >
                    <svg class="h-4 w-4 shrink-0 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Generated assets</h3>
                    <span class="text-xs text-slate-500 dark:text-slate-400">({{ displayFiles.length }} {{ displayFiles.length === 1 ? 'file' : 'files' }})</span>
                    <svg
                        class="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </summary>
                <div class="border-t border-slate-200 px-4 pb-4 pt-2 dark:border-slate-700">
                    <div class="overflow-x-auto">
                        <table class="w-full min-w-[28rem] text-left text-xs">
                            <thead>
                                <tr class="border-b border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                                    <th class="pb-2 pr-2 font-medium">File</th>
                                    <th class="pb-2 pr-2 font-medium">Type</th>
                                    <th class="pb-2 pr-2 font-medium">Size</th>
                                    <th class="pb-2 font-medium text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="f in (shouldCollapseFiles && !showFiles ? (displayFiles ?? []).slice(0, 12) : (displayFiles ?? []))"
                                    :key="f"
                                    class="border-b border-slate-100 last:border-0 dark:border-slate-700"
                                >
                                    <td class="py-1.5 pr-2 font-mono text-slate-800 dark:text-slate-200">{{ f.split('/').pop() || f }}</td>
                                    <td class="py-1.5 pr-2 text-slate-600 dark:text-slate-400">{{ inferOutputFileKind(f) }}</td>
                                    <td class="py-1.5 pr-2 text-slate-400">—</td>
                                    <td class="py-1.5 text-right">
                                        <button
                                            type="button"
                                            class="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                                            title="Copy URL"
                                            @click="emit('copyOutputObjectKey', f)"
                                        >
                                            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                                <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m0 0V18a2 2 0 01-2 2h-3m3 0l-3-3" />
                                            </svg>
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <button
                        v-if="shouldCollapseFiles"
                        type="button"
                        class="mt-2 text-xs font-medium text-slate-600 hover:underline dark:text-slate-400"
                        @click="showFiles = !showFiles"
                    >
                        {{ showFiles ? 'Show less' : `Show all ${displayFiles!.length} files` }}
                    </button>
                </div>
            </details>

            <div class="rounded-xl border border-slate-200 bg-slate-50/90 p-4 sm:p-5 dark:border-slate-700 dark:bg-slate-800/55">
                <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Session &amp; storage</h3>
                <dl class="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                    <div v-if="session?.s3Config?.endPoint">
                        <dt class="text-xs font-semibold uppercase tracking-wider text-slate-500">S3 endpoint</dt>
                        <dd class="mt-1 break-all font-mono text-slate-800 dark:text-slate-200">
                            {{ session.s3Config.endPoint }}{{ session.s3Config.port ? `:${session.s3Config.port}` : '' }}
                        </dd>
                    </div>
                    <div v-if="session?.s3Config?.bucket">
                        <dt class="text-xs font-semibold uppercase tracking-wider text-slate-500">Bucket</dt>
                        <dd class="mt-1 text-slate-800 dark:text-slate-200">{{ session.s3Config.bucket }}</dd>
                    </div>
                    <div v-if="session">
                        <dt class="text-xs font-semibold uppercase tracking-wider text-slate-500">Created</dt>
                        <dd class="mt-1 text-slate-800 dark:text-slate-200">{{ formatDate(session.createdAt) }}</dd>
                    </div>
                    <div v-if="session?.completedAt">
                        <dt class="text-xs font-semibold uppercase tracking-wider text-slate-500">Completed</dt>
                        <dd class="mt-1 text-slate-800 dark:text-slate-200">{{ formatDate(session.completedAt) }}</dd>
                    </div>
                </dl>
            </div>

            <div
                class="flex flex-col gap-3 rounded-xl border border-slate-200/90 bg-slate-50/60 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between dark:border-slate-700 dark:bg-slate-800/40"
            >
                <p class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Bucket tools
                </p>
                <div class="flex flex-wrap gap-2 sm:justify-end">
                    <button
                        v-if="hasS3Files && !showMoveForm && !showRenameForm"
                        type="button"
                        class="cursor-pointer rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        @click="emit('openMoveForm')"
                    >
                        Move files
                    </button>
                    <button
                        v-if="hasS3Files && !showMoveForm && !showRenameForm"
                        type="button"
                        class="cursor-pointer rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        @click="emit('openRenameForm')"
                    >
                        Rename prefix
                    </button>
                </div>
            </div>

            <div
                v-if="showMoveForm && hasS3Files"
                class="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 dark:border-slate-700 dark:bg-slate-800/80"
            >
                <p class="text-sm font-semibold text-slate-800 dark:text-slate-200">Move files to another S3 config</p>
                <div>
                    <label class="mb-1 block text-xs text-slate-500 dark:text-slate-400">Target S3 config</label>
                    <FormSelect
                        v-model="selectedTargetConfigId"
                        :options="moveTargetS3SelectOptions"
                        placeholder="Select a config…"
                        @change="emit('checkMovePrefix')"
                    />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-slate-500 dark:text-slate-400">Path prefix</label>
                    <input v-model="moveNewPrefix" type="text" placeholder="e.g. videos/project-1/" class="input" @blur="emit('checkMovePrefix')" />
                </div>
                <div v-if="movePrefixWarning" class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-950/40">
                    <p class="text-xs text-amber-800 dark:text-amber-400">{{ movePrefixWarning }}</p>
                    <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <input v-model="moveConfirmedOverwrite" type="checkbox" class="rounded accent-amber-600" />
                        I understand, proceed anyway
                    </label>
                </div>
                <p v-if="moveError" class="text-xs text-red-700 dark:text-red-400">{{ moveError }}</p>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        :disabled="!canMove"
                        class="cursor-pointer rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600"
                        @click="emit('confirmMove')"
                    >{{ moving ? 'Moving…' : 'Apply move' }}</button>
                    <button type="button" :disabled="moving" class="cursor-pointer rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600" @click="emit('cancelMove')">Cancel</button>
                </div>
            </div>

            <div
                v-if="showRenameForm && hasS3Files"
                class="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 dark:border-slate-700 dark:bg-slate-800/80"
            >
                <p class="text-sm font-semibold text-slate-800 dark:text-slate-200">Rename path prefix</p>
                <div>
                    <label class="mb-1 block text-xs text-slate-500 dark:text-slate-400">New prefix</label>
                    <input v-model="renameNewPrefix" type="text" placeholder="e.g. production/client-x/" class="input" @blur="emit('checkRenamePrefix')" />
                </div>
                <div v-if="renamePrefixWarning" class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-950/40">
                    <p class="text-xs text-amber-800 dark:text-amber-400">{{ renamePrefixWarning }}</p>
                    <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                        <input v-model="renameConfirmedOverwrite" type="checkbox" class="rounded accent-amber-600" />
                        I understand, proceed anyway
                    </label>
                </div>
                <p v-if="renameError" class="text-xs text-red-700 dark:text-red-400">{{ renameError }}</p>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        :disabled="!canRename"
                        class="cursor-pointer rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600"
                        @click="emit('confirmRename')"
                    >{{ renaming ? 'Renaming…' : 'Apply rename' }}</button>
                    <button type="button" :disabled="renaming" class="cursor-pointer rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600" @click="emit('cancelRename')">Cancel</button>
                </div>
            </div>

        </template>

        <div
            v-if="isTerminal"
            class="rounded-2xl border border-red-200/80 bg-red-50/50 p-4 dark:border-red-900/40 dark:bg-red-950/20"
        >
            <p class="text-sm font-semibold text-red-900 dark:text-red-300">Danger zone</p>
            <p class="mt-1 text-xs text-red-800/90 dark:text-red-400/90">Deleting removes this session from your history. Optionally delete objects from your bucket with the checkbox in the dialog.</p>
            <button
                type="button"
                class="mt-3 cursor-pointer rounded-xl border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
                @click="emit('deleteSession')"
            >
                Delete session permanently
            </button>
        </div>
    </div>
</template>
