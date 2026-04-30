const STATUS_LABELS: Record<string, string> = {
    created: 'Created',
    uploading: 'Uploading',
    uploaded: 'Uploaded',
    queued: 'Queued',
    encoding: 'Encoding',
    encrypting: 'Encrypting',
    uploading_to_s3: 'Uploading to S3',
    completed: 'Completed',
    failed: 'Failed',
};

export function statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
}

const STATUS_COLORS: Record<string, string> = {
    created: 'bg-zinc-800 text-zinc-400',
    uploading: 'bg-cyan-900/40 text-cyan-400',
    uploaded: 'bg-zinc-800 text-zinc-400',
    queued: 'bg-amber-900/40 text-amber-400',
    encoding: 'bg-indigo-900/40 text-indigo-400',
    encrypting: 'bg-amber-900/40 text-amber-400',
    uploading_to_s3: 'bg-cyan-900/40 text-cyan-400',
    completed: 'bg-emerald-900/40 text-emerald-400',
    failed: 'bg-red-900/40 text-red-400',
};

export function statusColor(status: string): string {
    return STATUS_COLORS[status] ?? 'bg-zinc-800 text-zinc-400';
}
