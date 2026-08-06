export type SessionStatus =
    | 'created'
    | 'uploaded'
    | 'uploading'
    | 'queued'
    | 'encoding'
    | 'encrypting'
    | 'uploading_to_s3'
    | 'completed'
    | 'failed';
