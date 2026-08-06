<script setup lang="ts">
import { apiBaseUrl, checkHealth, health, LAUNCH_URL } from '../store';
</script>

<template>
    <section class="panel">
        <h2>1 &middot; Connection</h2>

        <div class="grid">
            <label class="field">
                <span>Encoding API base URL</span>
                <input v-model="apiBaseUrl" type="text" spellcheck="false" />
            </label>
        </div>

        <div class="row" style="margin-top: 12px">
            <button :disabled="health.state === 'checking'" @click="checkHealth()">
                {{ health.state === 'checking' ? 'Checking…' : 'Check health' }}
            </button>

            <span v-if="health.state === 'ok'" class="badge ok">
                ok &middot; v{{ health.apiVersion || '?' }}
            </span>
            <span v-else-if="health.state === 'unreachable'" class="badge bad">
                unreachable
            </span>
            <span v-else-if="health.state === 'unknown'" class="badge">not checked</span>
        </div>

        <!-- Mirrors the real CMS: when the desktop app is not running, offer to
             launch it via its protocol handler, then let the user retry. -->
        <template v-if="health.state === 'unreachable'">
            <p class="note bad">
                GET {{ apiBaseUrl }}/api/cms/health failed ({{ health.error }}). The
                desktop app is probably not running.
            </p>
            <div class="row" style="margin-top: 10px">
                <a class="launch" :href="LAUNCH_URL">Open Luminary Media Convert</a>
                <button class="secondary" @click="checkHealth()">Retry</button>
            </div>
        </template>
    </section>
</template>
