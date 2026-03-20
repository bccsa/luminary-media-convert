import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nano from 'nano';
import { INDEXES } from './indexes.js';

const MAX_UPSERT_RETRIES = 10;
const DB_CONNECT_RETRY_INTERVAL_MS = 10_000;

@Injectable()
export class DatabaseService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseService.name);
    private db: nano.DocumentScope<unknown>;
    private server: nano.ServerScope;
    private ready = false;

    constructor() {
        const couchdbUrl = process.env.COUCHDB_URL || 'http://localhost:5984';
        this.server = nano(couchdbUrl);
        const dbName = process.env.COUCHDB_DATABASE || 'luminary';
        this.db = this.server.db.use(dbName);
    }

    async onModuleInit(): Promise<void> {
        await this.connectWithRetry();
    }

    private async connectWithRetry(): Promise<void> {
        const dbName = process.env.COUCHDB_DATABASE || 'luminary';

        while (!this.ready) {
            try {
                await this.initDatabase(dbName);
                this.ready = true;
            } catch (err) {
                this.logger.warn(
                    `CouchDB not available, retrying in ${DB_CONNECT_RETRY_INTERVAL_MS / 1000}s: ${err}`,
                );
                await new Promise((r) =>
                    setTimeout(r, DB_CONNECT_RETRY_INTERVAL_MS),
                );
            }
        }
    }

    private async initDatabase(dbName: string): Promise<void> {
        try {
            await this.server.db.get(dbName);
            this.logger.log(`Database '${dbName}' already exists`);
        } catch (err: any) {
            if (err.statusCode === 404) {
                await this.server.db.create(dbName);
                this.logger.log(`Database '${dbName}' created`);
            } else {
                throw err;
            }
        }

        this.db = this.server.db.use(dbName);

        for (const index of INDEXES) {
            try {
                await this.db.createIndex({
                    index: { fields: index.fields },
                    name: index.name,
                    ddoc: index.name,
                });
                this.logger.debug(`Index '${index.name}' ensured`);
            } catch (err) {
                this.logger.warn(
                    `Failed to create index '${index.name}': ${err}`,
                );
            }
        }

        this.logger.log('Database initialization complete');
    }

    isReady(): boolean {
        return this.ready;
    }

    getDb(): nano.DocumentScope<unknown> {
        return this.db;
    }

    async find<T>(query: nano.MangoQuery): Promise<nano.MangoResponse<T>> {
        return this.db.find(query) as Promise<nano.MangoResponse<T>>;
    }

    async insert(
        doc: nano.MaybeDocument,
    ): Promise<nano.DocumentInsertResponse> {
        return this.db.insert(doc);
    }

    async get<T>(id: string): Promise<T & nano.MaybeDocument> {
        return this.db.get(id) as Promise<T & nano.MaybeDocument>;
    }

    async destroy(id: string, rev: string): Promise<nano.DocumentDestroyResponse> {
        return this.db.destroy(id, rev);
    }

    async bulk(
        docs: nano.BulkModifyDocsWrapper,
    ): Promise<nano.DocumentBulkResponse[]> {
        return this.db.bulk(docs);
    }

    /**
     * Upsert a document with conflict retry.
     *
     * 1. If the doc has an `_id`, fetch the current rev from CouchDB.
     * 2. Diff the new content against the existing doc (ignoring `_rev`).
     *    If nothing changed, skip the write.
     * 3. Write the doc with the latest `_rev`.
     * 4. On conflict (409), retry with a random delay (up to 10 times).
     */
    async upsert(
        doc: nano.MaybeDocument & { _id: string },
    ): Promise<nano.DocumentInsertResponse> {
        for (let attempt = 0; attempt < MAX_UPSERT_RETRIES; attempt++) {
            try {
                // Fetch existing doc to get the current _rev
                const existing = await this.db.get(doc._id).catch((err: any) => {
                    if (err.statusCode === 404) return null;
                    throw err;
                });

                if (existing) {
                    // Check if content actually changed (ignore _rev)
                    const { _rev: _existingRev, ...existingContent } = existing as any;
                    const { _rev: _newRev, ...newContent } = doc as any;
                    if (JSON.stringify(existingContent) === JSON.stringify(newContent)) {
                        return { ok: true, id: doc._id, rev: existing._rev! } as nano.DocumentInsertResponse;
                    }
                    (doc as any)._rev = existing._rev;
                }

                return await this.db.insert(doc);
            } catch (err: any) {
                if (err.statusCode === 409 && attempt < MAX_UPSERT_RETRIES - 1) {
                    const delay = Math.random() * 100 * (attempt + 1);
                    this.logger.debug(
                        `Upsert conflict on ${doc._id}, retry ${attempt + 1}/${MAX_UPSERT_RETRIES} after ${Math.round(delay)}ms`,
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }

                if (err.statusCode === 409) {
                    this.logger.warn(
                        `Upsert failed for ${doc._id} after ${MAX_UPSERT_RETRIES} retries — document update conflict`,
                    );
                }
                throw err;
            }
        }

        // Should never reach here, but satisfy TypeScript
        throw new Error(`Upsert failed for ${doc._id}`);
    }
}
