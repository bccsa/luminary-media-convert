/**
 * Which S3 profile each session was created with.
 *
 * Deliberately tiny. The encoder owns session state and this does not duplicate
 * any of it — it records only what the encoder cannot: the id of the stored
 * profile, so that a later chapter or playlist edit can resolve the same
 * credentials without the renderer ever holding them.
 *
 * The encoder does keep a copy of the credentials inside the session, but it
 * does not hand them back out, and it should not — a listing that returned S3
 * secrets would be a much worse problem than this file.
 */

import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SessionIndex {
    #path;
    #entries = new Map();

    constructor(filePath) {
        this.#path = filePath;
        this.#load();
    }

    #load() {
        if (!existsSync(this.#path)) return;
        try {
            const parsed = JSON.parse(readFileSync(this.#path, 'utf-8'));
            this.#entries = new Map(Object.entries(parsed ?? {}));
        } catch {
            // Losing this means chapter edits need the session recreated — bad,
            // but not a reason to refuse to start.
            this.#entries = new Map();
        }
    }

    #save() {
        mkdirSync(dirname(this.#path), { recursive: true });
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#entries), null, 2), {
            mode: 0o600,
        });
        renameSync(tmp, this.#path);
    }

    get(sessionId) {
        return this.#entries.get(sessionId);
    }

    set(sessionId, entry) {
        this.#entries.set(sessionId, entry);
        this.#save();
    }

    delete(sessionId) {
        if (this.#entries.delete(sessionId)) this.#save();
    }

    /**
     * Forget entries for sessions the encoder no longer has.
     *
     * Without this the file grows for the life of the install, since the
     * encoder is free to sweep a session without telling anyone.
     */
    prune(liveSessionIds) {
        const live = new Set(liveSessionIds);
        let changed = false;
        for (const id of this.#entries.keys()) {
            if (!live.has(id)) {
                this.#entries.delete(id);
                changed = true;
            }
        }
        if (changed) this.#save();
    }
}
