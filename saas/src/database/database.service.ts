import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nano from 'nano';
import { INDEXES } from './indexes.js';

@Injectable()
export class DatabaseService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseService.name);
    private db: nano.DocumentScope<unknown>;
    private server: nano.ServerScope;

    constructor() {
        const couchdbUrl = process.env.COUCHDB_URL || 'http://localhost:5984';
        this.server = nano(couchdbUrl);
        const dbName = process.env.COUCHDB_DATABASE || 'luminary';
        this.db = this.server.db.use(dbName);
    }

    async onModuleInit(): Promise<void> {
        const dbName = process.env.COUCHDB_DATABASE || 'luminary';

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

    getDb(): nano.DocumentScope<unknown> {
        return this.db;
    }

    async find<T>(query: nano.MangoQuery): Promise<nano.MangoResponse<T>> {
        return this.db.find(query) as Promise<nano.MangoResponse<T>>;
    }

    async insert<T>(
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
}
