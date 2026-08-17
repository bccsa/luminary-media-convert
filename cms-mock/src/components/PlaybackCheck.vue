<script setup lang="ts">
import { computed } from 'vue';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    checkPlayback,
    playback,
    selectAngle,
    stream,
} from '../store';

/** The 16 raw key bytes the player hands to the decryptor, as a data URI. */
function keyDataUri(hex: string): string {
    const bytes = hex.match(/../g) ?? [];
    const binary = bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join('');
    return `data:application/octet-stream;base64,${btoa(binary)}`;
}

const swappedKeyLine = computed(() => {
    const hlsKey = stream.media?.hlsKey;
    if (!playback.keyLine || !playback.hasPlaceholder || !hlsKey) return '';
    return playback.keyLine.replace(LUMINARY_KEY_PLACEHOLDER_URI, keyDataUri(hlsKey));
});
</script>

<template>
    <section class="panel">
        <h2>4 &middot; Playback check</h2>

        <p v-if="!stream.media" class="note">
            No <code>hlsUrl</code> reported yet — it arrives with the first
            <code>encoding</code> event.
        </p>

        <template v-else>
            <p class="note" style="margin-top: 0">
                <code>{{ stream.media.hlsUrl }}</code>
            </p>

            <div class="row">
                <button :disabled="playback.checking" @click="checkPlayback()">
                    {{ playback.checking ? 'Fetching…' : 'Check playback' }}
                </button>
                <span v-if="playback.state === 'ready'" class="badge ok">available</span>
                <span v-else-if="playback.state === 'unavailable'" class="badge warn">
                    not available yet
                </span>
            </div>

            <p v-if="playback.state === 'unavailable'" class="note">
                The master playlist is not readable yet ({{ playback.error }}). The real
                CMS player shows a placeholder and retries — segments land in S3 as the
                encode progresses.
            </p>

            <template v-if="playback.state === 'ready'">
                <h3>Video angles ({{ playback.angles.length }})</h3>
                <p v-if="!playback.angles.length" class="note" style="margin-top: 0">
                    Single-angle master — no <code>TYPE=VIDEO</code> rendition groups.
                </p>
                <div v-else class="row">
                    <button
                        v-for="angle in playback.angles"
                        :key="angle.id"
                        :class="{ secondary: angle.id !== playback.selectedAngleId }"
                        @click="selectAngle(angle.id)"
                    >
                        {{ angle.name }}{{ angle.isDefault ? ' (default)' : '' }}
                    </button>
                </div>

                <h3>Encryption</h3>
                <template v-if="playback.keyLine">
                    <div class="row">
                        <span
                            class="badge"
                            :class="playback.hasPlaceholder ? 'ok' : 'warn'"
                        >
                            {{
                                playback.hasPlaceholder
                                    ? 'luminary://key placeholder present'
                                    : 'literal key URI'
                            }}
                        </span>
                        <span v-if="playback.variantUrl" class="note" style="margin: 0">
                            from <code>{{ playback.variantUrl }}</code>
                        </span>
                    </div>
                    <pre class="block">{{ playback.keyLine }}</pre>
                    <template v-if="swappedKeyLine">
                        <h3>After the player's key swap</h3>
                        <pre class="block">{{ swappedKeyLine }}</pre>
                        <p class="note">
                            The real player substitutes a blob URL over the reported
                            <code>hlsKey</code>; a data URI is shown here so the swap is
                            inspectable.
                        </p>
                    </template>
                    <p v-else-if="playback.hasPlaceholder" class="note">
                        No <code>hlsKey</code> was reported, so there is nothing to swap
                        in.
                    </p>
                </template>
                <p v-else class="note" style="margin-top: 0">
                    No <code>#EXT-X-KEY</code> found — this output is unencrypted.
                </p>

                <h3>Extracted playlist</h3>
                <pre class="block">{{ playback.extractedText }}</pre>

                <template v-if="playback.audioOnlyText">
                    <h3>Audio-only playlist</h3>
                    <pre class="block">{{ playback.audioOnlyText }}</pre>
                </template>
            </template>
        </template>
    </section>
</template>
