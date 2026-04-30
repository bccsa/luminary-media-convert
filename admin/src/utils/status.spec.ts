import { describe, it, expect } from 'vitest';
import { statusLabel, statusColor } from './status';

describe('statusLabel', () => {
    it('returns mapped label for known statuses', () => {
        expect(statusLabel('created')).toBe('Created');
        expect(statusLabel('uploading')).toBe('Uploading');
        expect(statusLabel('uploaded')).toBe('Uploaded');
        expect(statusLabel('queued')).toBe('Queued');
        expect(statusLabel('encoding')).toBe('Encoding');
        expect(statusLabel('encrypting')).toBe('Encrypting');
        expect(statusLabel('uploading_to_s3')).toBe('Uploading to S3');
        expect(statusLabel('completed')).toBe('Completed');
        expect(statusLabel('failed')).toBe('Failed');
    });

    it('returns raw status for unknown statuses', () => {
        expect(statusLabel('unknown_status')).toBe('unknown_status');
    });
});

describe('statusColor', () => {
    it('returns mapped color for known statuses', () => {
        expect(statusColor('completed')).toContain('emerald');
        expect(statusColor('failed')).toContain('red');
        expect(statusColor('encoding')).toContain('indigo');
        expect(statusColor('queued')).toContain('amber');
        expect(statusColor('uploading')).toContain('cyan');
        expect(statusColor('created')).toContain('zinc');
        expect(statusColor('uploaded')).toContain('zinc');
        expect(statusColor('encrypting')).toContain('amber');
        expect(statusColor('uploading_to_s3')).toContain('cyan');
    });

    it('returns default color for unknown statuses', () => {
        expect(statusColor('unknown')).toBe('bg-zinc-800 text-zinc-400');
    });
});
