/** Human-readable label per status. Colors stay local to each view. */
export const STATUS_LABELS: Record<string, string> = {
    created: 'Waiting for a file',
    uploading: 'Reading source',
    uploaded: 'Ready to encode',
    queued: 'Queued',
    encoding: 'Encoding',
    encrypting: 'Encrypting',
    uploading_to_s3: 'Uploading to S3',
    completed: 'Completed',
    failed: 'Failed',
};

/** Label for a status, falling back to the raw status string. */
export function statusLabel(status: string | null | undefined): string {
    if (!status) return '';
    return STATUS_LABELS[status] ?? status;
}

/** Statuses past which nothing more will happen on its own. */
export function isTerminalStatus(status: string | null | undefined): boolean {
    return status === 'completed' || status === 'failed';
}

/** Statuses where work is actively in flight — the ones worth a progress bar. */
export function isActiveStatus(status: string | null | undefined): boolean {
    return (
        status === 'uploading' ||
        status === 'queued' ||
        status === 'encoding' ||
        status === 'encrypting' ||
        status === 'uploading_to_s3'
    );
}
