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
        });

        it('should create database if it does not exist', async () => {
            mockServerDbGet.mockRejectedValueOnce({ statusCode: 404 });

            await service.onModuleInit();

            expect(mockServerDbCreate).toHaveBeenCalledWith('luminary');
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

        it('should rethrow non-404 errors from db.get', async () => {
            mockServerDbGet.mockRejectedValueOnce({
                statusCode: 500,
                message: 'Internal error',
            });

            await expect(service.onModuleInit()).rejects.toEqual({
                statusCode: 500,
                message: 'Internal error',
            });
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
});
