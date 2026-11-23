<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import {
    ack,
    disconnect,
    followed,
    reconnect,
    storedMedia,
    stream,
} from '../store';
import type { StoreKind } from '../types';

const logEl = ref<HTMLElement | null>(null);
const follow = ref(true);

watch(
    () => stream.events.length,
    async () => {
        if (!follow.value) return;
        await nextTick();
        if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
    }
);

const stateBadge: Record<string, string> = {
    idle: '',
    connecting: 'warn',
    open: 'ok',
    error: 'bad',
};

/** What the real CMS would have done with the URL; the mock stores both at once. */
const storedLabel: Record<StoreKind, string> = {
    'same-folder': 'hlsUrl → auto-saved (same folder)',
    'new-folder': 'hlsUrl → stored (real CMS: on the editor’s Save)',
};
</script>

<template>
    <section class="panel">
        <h2>3 &middot; SSE console</h2>

        <div class="row">
            <span class="badge" :class="stateBadge[stream.state]">
                {{ stream.state }}
            </span>
            <span class="note" style="margin: 0">
                {{ stream.events.length }} event(s)
            </span>
            <label class="check"><input v-model="follow" type="checkbox" /> follow</label>
            <button
                class="secondary"
                :disabled="!followed.sessionId"
                @click="reconnect()"
            >
                Reconnect
            </button>
            <button
                class="secondary"
                :disabled="stream.state === 'idle'"
                @click="disconnect()"
            >
                Disconnect
            </button>
        </div>

        <p v-if="followed.sessionId" class="note">
            Following <code>{{ followed.sessionId }}</code> for
            <code>{{ followed.documentId }}</code> — kept across reloads and after the
            session completes. Disconnect is the CMS tab closing: the encoder then
            refuses saves.
        </p>
        <p v-if="stream.notice" class="note bad">{{ stream.notice }}</p>

        <p v-if="stream.state === 'error'" class="note bad">
            Stream dropped. EventSource retries on its own — this clears once an event
            arrives.
        </p>

        <!-- Acknowledging is what lets the encoder take the next save. -->
        <div class="row" style="margin-top: 10px">
            <label class="check">
                <input v-model="ack.enabled" type="checkbox" />
                Acknowledge stored versions
            </label>
            <span v-if="!ack.enabled" class="badge warn">
                off — the encoder stays pending
            </span>
            <span v-else-if="ack.state === 'acked'" class="badge ok">
                acked &middot; {{ ack.at }}
            </span>
            <span v-else-if="ack.state === 'unsupported'" class="badge">
                ack 404 ignored
            </span>
            <span v-else-if="ack.state === 'error'" class="badge bad">ack failed</span>
        </div>
        <p v-if="ack.state" class="note">
            Last ack: <code>{{ ack.hlsUrl }}</code>
            <template v-if="ack.detail"> — {{ ack.detail }}</template>
        </p>

        <!-- The persistent record of what the real CMS has stored. -->
        <div v-if="storedMedia" class="media-card" style="margin-top: 12px">
            <h3>What Luminary has stored (MediaDto)</h3>
            <pre>{{ JSON.stringify(storedMedia, null, 2) }}</pre>
        </div>

        <p v-if="!followed.sessionId && !stream.events.length" class="note">
            Create a session above to start the stream.
        </p>

        <div v-else ref="logEl" class="log">
            <p v-if="!stream.events.length" class="note" style="padding: 8px">
                Waiting for events…
            </p>
            <div
                v-for="entry in stream.events"
                :key="entry.id"
                class="log-entry"
                :class="{ 'save-point': entry.stored }"
            >
                <div class="log-meta">
                    <span>#{{ entry.id }}</span>
                    <span>{{ entry.at }}</span>
                    <span v-if="entry.data.status" class="badge">
                        {{ entry.data.status }}
                    </span>
                    <span v-if="entry.data.cmsPending" class="badge warn">
                        cmsPending
                    </span>
                    <span v-if="entry.stored" class="badge ok">
                        {{ storedLabel[entry.stored] }}
                    </span>
                </div>
                <pre>{{ entry.raw }}</pre>
            </div>
        </div>
    </section>
</template>
