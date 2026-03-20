import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseService } from './database.service.js';
import { INDEXES } from './indexes.js';

const mockDb = {
    createIndex: vi.fn().mockResolvedValue({}),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    insert: vi.fn().mockResolvedValue({ ok: true, id: 'test', rev: '1-abc' }),
    get: vi.fn().mockResolvedValue({ _id: 'test', _rev: '1-abc' }),
    destroy: vi.fn().mockResolvedValue({ ok: true }),
    bulk: vi.fn().mockResolvedValue([]),
};

const mockServerDbGet = vi.fn();
const mockServerDbCreate = vi.fn().mockResolvedValue({});
const mockServerDbUse = vi.fn().mockReturnValue(mockDb);

vi.mock('nano', () => ({
    default: vi.fn().mockImplementation(() => ({
        db: {
            get: mockServerDbGet,
            create: mockServerDbCreate,
            use: mockServerDbUse,
        },
    })),
}));

describe('DatabaseService', () => {
    let service: DatabaseService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockServerDbUse.mockReturnValue(mockDb);
        service = new DatabaseService();
    });

    describe('onModuleInit', () => {
        it('should use existing database if it exists', async () => {
            mockServerDbGet.mockResolvedValueOnce({});

            await service.onModuleInit();

            expect(mockServerDbGet).toHaveBeenCalledWith('luminary');
            expect(mockServerDbCreate).not.toHaveBeenCalled();
            expect(service.isReady()).toBe(true);
        });

        it('should create database if it does not exist', async () => {
            mockServerDbGet.mockRejectedValueOnce({ statusCode: 404 });

            await service.onModuleInit();

            expect(mockServerDbCreate).toHaveBeenCalledWith('luminary');
            expect(service.isReady()).toBe(true);
        });

        it('should create all indexes', async () => {
            mockServerDbGet.mockResolvedValueOnce({});

            await service.onModuleInit();

            expect(mockDb.createIndex).toHaveBeenCalledTimes(INDEXES.length);
            for (const index of INDEXES) {
                expect(mockDb.createIndex).toHaveBeenCalledWith({
                    index: { fields: index.fields },
                    name: index.name,
                    ddoc: index.name,
                });
            }
        });

        it('should retry on connection error and succeed when CouchDB becomes available', async () => {
            vi.useFakeTimers();

            // First attempt: connection error
            mockServerDbGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
            // Second attempt: success
            mockServerDbGet.mockResolvedValueOnce({});

            const initPromise = service.onModuleInit();

            // Advance past the retry delay
            await vi.advanceTimersByTimeAsync(10_000);
            await initPromise;

            expect(mockServerDbGet).toHaveBeenCalledTimes(2);
            expect(service.isReady()).toBe(true);

            vi.useRealTimers();
        });
    });

    describe('getDb', () => {
        it('should return the database scope', () => {
            const db = service.getDb();
            expect(db).toBeDefined();
        });
    });

    describe('find', () => {
        it('should delegate to nano db.find', async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();

            const query = { selector: { docType: 'user' } };
            await service.find(query);

            expect(mockDb.find).toHaveBeenCalledWith(query);
        });
    });

    describe('insert', () => {
        it('should delegate to nano db.insert', async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();

            const doc = { _id: 'test', name: 'Test' };
            await service.insert(doc);

            expect(mockDb.insert).toHaveBeenCalledWith(doc);
        });
    });

    describe('get', () => {
        it('should delegate to nano db.get', async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();

            await service.get('test-id');

            expect(mockDb.get).toHaveBeenCalledWith('test-id');
        });
    });

    describe('destroy', () => {
        it('should delegate to nano db.destroy', async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();

            await service.destroy('test-id', '1-abc');

            expect(mockDb.destroy).toHaveBeenCalledWith('test-id', '1-abc');
        });
    });

    describe('bulk', () => {
        it('should delegate to nano db.bulk', async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();

            const docs = { docs: [{ _id: 'a' }, { _id: 'b' }] };
            await service.bulk(docs);

            expect(mockDb.bulk).toHaveBeenCalledWith(docs);
        });
    });

    describe('upsert', () => {
        beforeEach(async () => {
            mockServerDbGet.mockResolvedValueOnce({});
            await service.onModuleInit();
        });

        it('should insert new doc when it does not exist', async () => {
            mockDb.get.mockRejectedValueOnce({ statusCode: 404 });
            mockDb.insert.mockResolvedValueOnce({ ok: true, id: 'doc:1', rev: '1-new' });

            const result = await service.upsert({ _id: 'doc:1', name: 'New' } as any);

            expect(result.rev).toBe('1-new');
            expect(mockDb.insert).toHaveBeenCalledWith(
                expect.objectContaining({ _id: 'doc:1', name: 'New' }),
            );
        });

        it('should update existing doc with latest _rev', async () => {
            mockDb.get.mockResolvedValueOnce({ _id: 'doc:1', _rev: '1-old', name: 'Old' });
            mockDb.insert.mockResolvedValueOnce({ ok: true, id: 'doc:1', rev: '2-new' });

            const result = await service.upsert({ _id: 'doc:1', name: 'Updated' } as any);

            expect(result.rev).toBe('2-new');
            expect(mockDb.insert).toHaveBeenCalledWith(
                expect.objectContaining({ _id: 'doc:1', _rev: '1-old', name: 'Updated' }),
            );
        });

        it('should skip write when content has not changed', async () => {
            mockDb.get.mockResolvedValueOnce({ _id: 'doc:1', _rev: '1-old', name: 'Same' });

            const result = await service.upsert({ _id: 'doc:1', name: 'Same' } as any);

            expect(result.rev).toBe('1-old');
            expect(mockDb.insert).not.toHaveBeenCalled();
        });

        it('should retry on 409 conflict', async () => {
            // First attempt: conflict
            mockDb.get.mockResolvedValueOnce({ _id: 'doc:1', _rev: '1-old', name: 'Old' });
            mockDb.insert.mockRejectedValueOnce({ statusCode: 409 });
            // Second attempt: success
            mockDb.get.mockResolvedValueOnce({ _id: 'doc:1', _rev: '2-mid', name: 'Old' });
            mockDb.insert.mockResolvedValueOnce({ ok: true, id: 'doc:1', rev: '3-new' });

            const result = await service.upsert({ _id: 'doc:1', name: 'Updated' } as any);

            expect(result.rev).toBe('3-new');
            expect(mockDb.get).toHaveBeenCalledTimes(2);
        });

        it('should throw after max retries on persistent conflict', async () => {
            for (let i = 0; i < 10; i++) {
                mockDb.get.mockResolvedValueOnce({ _id: 'doc:1', _rev: `${i}-rev`, name: 'Old' });
                mockDb.insert.mockRejectedValueOnce({ statusCode: 409 });
            }

            await expect(
                service.upsert({ _id: 'doc:1', name: 'Updated' } as any),
            ).rejects.toEqual(expect.objectContaining({ statusCode: 409 }));
        });
    });
});
