export interface UserDocument {
    _id: string;
    _rev?: string;
    docType: 'user';
    auth0Id: string | null;
    email: string;
    name: string;
    role: 'user' | 'admin';
    status: 'active' | 'disabled' | 'pending_verification';
    sessionRetentionDaysOverride: number | null;
    emailVerifiedAt: string | null;
    invitedBy: string | null;
    onboardingCompletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
