<script setup lang="ts">
import { onMounted } from 'vue';
import ConnectionPanel from './components/ConnectionPanel.vue';
import CreateSessionPanel from './components/CreateSessionPanel.vue';
import EventConsole from './components/EventConsole.vue';
import PlaybackCheck from './components/PlaybackCheck.vue';
import { checkHealth } from './store';

onMounted(() => {
    void checkHealth();
});
</script>

<template>
    <main class="app">
        <header class="app-header">
            <h1>Luminary CMS (mock)</h1>
            <p>
                Dev-only stand-in for the CMS side of the contract. Served from
                <code>http://localhost:5199</code> so requests to the encoding API are
                genuinely cross-origin.
            </p>
        </header>

        <ConnectionPanel />
        <CreateSessionPanel />
        <EventConsole />
        <PlaybackCheck />
    </main>
</template>
