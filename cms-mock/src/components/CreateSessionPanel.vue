<script setup lang="ts">
import { createSession, form, session } from '../store';
</script>

<template>
    <section class="panel">
        <h2>2 &middot; Create session</h2>

        <div class="grid">
            <label class="field">
                <span>documentId</span>
                <input v-model="form.documentId" type="text" spellcheck="false" />
            </label>
            <label class="field">
                <span>title</span>
                <input v-model="form.title" type="text" />
            </label>
            <label class="field">
                <span>publicBaseUrl</span>
                <input v-model="form.publicBaseUrl" type="text" spellcheck="false" />
            </label>
        </div>

        <h3>S3</h3>
        <div class="grid">
            <label class="field">
                <span>endPoint</span>
                <input v-model="form.s3.endPoint" type="text" spellcheck="false" />
            </label>
            <label class="field">
                <span>port</span>
                <input v-model.number="form.s3.port" type="number" />
            </label>
            <label class="field">
                <span>bucket</span>
                <input v-model="form.s3.bucket" type="text" spellcheck="false" />
            </label>
            <label class="field">
                <span>region</span>
                <input v-model="form.s3.region" type="text" spellcheck="false" />
            </label>
            <label class="field">
                <span>accessKey</span>
                <input v-model="form.s3.accessKey" type="text" spellcheck="false" />
            </label>
            <label class="field">
                <span>secretKey</span>
                <input v-model="form.s3.secretKey" type="password" />
            </label>
            <label class="field">
                <span>pathPrefix</span>
                <input v-model="form.s3.pathPrefix" type="text" spellcheck="false" />
            </label>
            <label class="check" style="align-self: end; padding-bottom: 8px">
                <input v-model="form.s3.useSSL" type="checkbox" />
                useSSL
            </label>
        </div>

        <h3>Options</h3>
        <div class="grid">
            <label class="check">
                <input v-model="form.requireEncryption" type="checkbox" />
                require encryption
            </label>
            <label class="check">
                <input v-model="form.thumbnails" type="checkbox" />
                thumbnails
            </label>
            <label class="check">
                <input v-model="form.byteRange" type="checkbox" />
                byteRange
            </label>
            <label class="field">
                <span>byteRangeMaxFileSizeMB</span>
                <input v-model.number="form.byteRangeMaxFileSizeMB" type="number" />
            </label>
            <label class="field">
                <span>segmentDuration (s)</span>
                <input v-model.number="form.segmentDuration" type="number" />
            </label>
        </div>

        <div class="row" style="margin-top: 14px">
            <button :disabled="session.creating" @click="createSession()">
                {{ session.creating ? 'Creating…' : 'POST /api/cms/sessions' }}
            </button>
            <span v-if="session.response?.reused" class="badge warn">reused</span>
            <span v-else-if="session.response" class="badge ok">new session</span>
        </div>

        <p v-if="session.error" class="note bad">{{ session.error }}</p>

        <pre v-if="session.response" class="block">{{
            JSON.stringify(session.response, null, 2)
        }}</pre>
    </section>
</template>
