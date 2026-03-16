export const INDEXES = [
    { name: 'users-by-email', fields: ['docType', 'email'] },
    { name: 'users-by-auth0id', fields: ['docType', 'auth0Id'] },
    { name: 'sessions-by-user', fields: ['docType', 'userId', 'createdAt'] },
    {
        name: 'sessions-by-user-status',
        fields: ['docType', 'userId', 'status'],
    },
    { name: 'sessions-by-expiry', fields: ['docType', 'expiresAt'] },
    { name: 'apikeys-by-user', fields: ['docType', 'userId', 'createdAt'] },
    {
        name: 'usage-by-user-period',
        fields: ['docType', 'userId', 'createdAt'],
    },
    { name: 'billing-by-user', fields: ['docType', 'userId'] },
    { name: 's3configs-by-user', fields: ['docType', 'userId', 'createdAt'] },
];
