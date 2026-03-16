import { ApiKeyService } from './apikey.service';

describe('ApiKeyService', () => {
    let service: ApiKeyService;

    beforeEach(() => {
        service = new ApiKeyService();
    });

    describe('create', () => {
        it('should generate a key starting with lmc_', () => {
            const { key } = service.create({ name: 'Test Key' });
            expect(key).toMatch(/^lmc_[0-9a-f]{64}$/);
        });

        it('should return a record with correct fields', () => {
            const { record } = service.create({
                name: 'Test Key',
                webhookUrl: 'https://example.com/hook',
                authorizationUrl: 'https://example.com/auth',
                metadata: { env: 'test' },
            });

            expect(record.id).toBeDefined();
            expect(record.name).toBe('Test Key');
            expect(record.webhookUrl).toBe('https://example.com/hook');
            expect(record.authorizationUrl).toBe('https://example.com/auth');
            expect(record.metadata).toEqual({ env: 'test' });
            expect(record.keyPrefix).toMatch(/^lmc_[0-9a-f]{8}$/);
            expect(record.createdAt).toBeInstanceOf(Date);
            expect(record.revokedAt).toBeUndefined();
        });

        it('should store expiresAt as a Date when provided', () => {
            const { record } = service.create({
                name: 'Expiring Key',
                expiresAt: '2027-01-01T00:00:00Z',
            });

            expect(record.expiresAt).toBeInstanceOf(Date);
            expect(record.expiresAt!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
        });

        it('should generate unique keys', () => {
            const { key: k1 } = service.create({ name: 'Key 1' });
            const { key: k2 } = service.create({ name: 'Key 2' });
            expect(k1).not.toBe(k2);
        });
    });

    describe('validateKey', () => {
        it('should validate a correct key and return the record', () => {
            const { key } = service.create({ name: 'Valid' });
            const record = service.validateKey(key);

            expect(record).not.toBeNull();
            expect(record!.name).toBe('Valid');
        });

        it('should update lastUsedAt on successful validation', () => {
            const { key } = service.create({ name: 'Valid' });
            const before = Date.now();
            const record = service.validateKey(key);

            expect(record!.lastUsedAt).toBeInstanceOf(Date);
            expect(record!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before);
        });

        it('should return null for unknown key', () => {
            expect(service.validateKey('lmc_unknown')).toBeNull();
        });

        it('should return null for revoked key', () => {
            const { key, record } = service.create({ name: 'Revoked' });
            service.revoke(record.id);

            expect(service.validateKey(key)).toBeNull();
        });

        it('should return null for expired key', () => {
            const { key } = service.create({
                name: 'Expired',
                expiresAt: '2020-01-01T00:00:00Z',
            });

            expect(service.validateKey(key)).toBeNull();
        });

        it('should allow non-expired key', () => {
            const { key } = service.create({
                name: 'Future',
                expiresAt: '2099-01-01T00:00:00Z',
            });

            expect(service.validateKey(key)).not.toBeNull();
        });
    });

    describe('findAll', () => {
        it('should return all non-revoked records', () => {
            service.create({ name: 'A' });
            const { record: b } = service.create({ name: 'B' });
            service.create({ name: 'C' });
            service.revoke(b.id);

            const all = service.findAll();
            expect(all).toHaveLength(2);
            expect(all.map((r) => r.name).sort()).toEqual(['A', 'C']);
        });

        it('should return empty array when no keys exist', () => {
            expect(service.findAll()).toEqual([]);
        });
    });

    describe('findById', () => {
        it('should return a record by id', () => {
            const { record } = service.create({ name: 'Lookup' });
            expect(service.findById(record.id)?.name).toBe('Lookup');
        });

        it('should return undefined for unknown id', () => {
            expect(service.findById('nonexistent')).toBeUndefined();
        });
    });

    describe('revoke', () => {
        it('should mark the key as revoked', () => {
            const { record } = service.create({ name: 'Revocable' });
            const result = service.revoke(record.id);

            expect(result).toBe(true);
            expect(service.findById(record.id)?.revokedAt).toBeInstanceOf(Date);
        });

        it('should return false for unknown id', () => {
            expect(service.revoke('nonexistent')).toBe(false);
        });

        it('should return false for already revoked key', () => {
            const { record } = service.create({ name: 'Double Revoke' });
            service.revoke(record.id);

            expect(service.revoke(record.id)).toBe(false);
        });

        it('should prevent the key from being validated after revocation', () => {
            const { key, record } = service.create({ name: 'Revoked' });
            service.revoke(record.id);

            expect(service.validateKey(key)).toBeNull();
        });
    });
});
