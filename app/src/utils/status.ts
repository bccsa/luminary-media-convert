import type { SessionStatus } from '../types';

/** All session statuses surfaced in the UI, including the SaaS-only `imported`. */
export type DisplaySessionStatus = SessionStatus | 'imported';

/** Ordered list of statuses for filter dropdowns. */
export const SESSION_STATUSES: readonly DisplaySessionStatus[] = [
    'created',
    'uploading',
    'uploaded',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
    'completed',
    'failed',
    'imported',
];

/** Human-readable label per status. Colors stay local to each view. */
export const STATUS_LABELS: Record<string, string> = {
    created: 'Created',
    uploading: 'Uploading',
    uploaded: 'Uploaded',
    queued: 'Queued',
    encoding: 'Encoding',
    encrypting: 'Encrypting',
    uploading_to_s3: 'Uploading to S3',
    completed: 'Completed',
    failed: 'Failed',
    imported: 'Imported',
};

/** Label for a status, falling back to the raw status string. */
export function statusLabel(status: string | null | undefined): string {
    if (!status) return '';
    return STATUS_LABELS[status] ?? status;
}
