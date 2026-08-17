<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { disconnect, session, stream, subscribe } from '../store';

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
                :disabled="!session.response"
                @click="session.response && subscribe(session.response.eventsUrl)"
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

        <p v-if="stream.state === 'error'" class="note bad">
            Stream dropped. EventSource retries on its own — this clears once an event
            arrives.
        </p>

        <!-- The persistent record of what the real CMS would have written. -->
        <div v-if="stream.media" class="media-card">
            <h3>What Luminary would save (MediaDto)</h3>
            <pre>{{ JSON.stringify(stream.media, null, 2) }}</pre>
        </div>

        <p v-if="!session.response" class="note">
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
                :class="{ 'save-point': entry.isSavePoint }"
            >
                <div class="log-meta">
                    <span>#{{ entry.id }}</span>
                    <span>{{ entry.at }}</span>
                    <span v-if="entry.data.status" class="badge">
                        {{ entry.data.status }}
                    </span>
                    <span v-if="entry.isSavePoint" class="badge ok">hlsUrl &rarr; save</span>
                </div>
                <pre>{{ entry.raw }}</pre>
            </div>
        </div>
    </section>
</template>
