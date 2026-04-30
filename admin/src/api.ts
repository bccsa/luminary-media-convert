const BASE_URL = import.meta.env.VITE_SAAS_SERVICE_URL;

async function fetchApi(
    path: string,
    token: string,
    opts?: RequestInit,
) {
    const res = await fetch(`${BASE_URL}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...opts?.headers,
        },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

export async function getCurrentUser(token: string) {
    return fetchApi('/saas/admin/users/me', token);
}

export async function listUsers(
    token: string,
    params?: { limit?: number; skip?: number; search?: string },
) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.skip) query.set('skip', String(params.skip));
    if (params?.search) query.set('search', params.search);
    return fetchApi(`/saas/admin/users?${query}`, token);
}

export async function getUser(token: string, userId: string) {
    return fetchApi(`/saas/admin/users/${userId}`, token);
}

export async function createUser(
    token: string,
    data: { email: string; name: string; role?: string },
) {
    return fetchApi('/saas/admin/users', token, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateUser(
    token: string,
    userId: string,
    data: Record<string, unknown>,
) {
    return fetchApi(`/saas/admin/users/${userId}`, token, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function disableUser(token: string, userId: string) {
    return fetchApi(`/saas/admin/users/${userId}/disable`, token, {
        method: 'POST',
    });
}

export async function enableUser(token: string, userId: string) {
    return fetchApi(`/saas/admin/users/${userId}/enable`, token, {
        method: 'POST',
    });
}

export async function deleteUser(token: string, userId: string) {
    return fetchApi(`/saas/admin/users/${userId}`, token, {
        method: 'DELETE',
    });
}

// --- Sessions ---

export async function listAllSessions(
    token: string,
    params?: { limit?: number; skip?: number; status?: string; userId?: string },
) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.skip) query.set('skip', String(params.skip));
    if (params?.status) query.set('status', params.status);
    if (params?.userId) query.set('userId', params.userId);
    return fetchApi(`/saas/admin/sessions?${query}`, token);
}

export async function getSession(token: string, sessionId: string) {
    return fetchApi(`/saas/admin/sessions/${sessionId}`, token);
}

// --- Session SSE ---

export function subscribeSessionEvents(
    token: string,
    onEvent: (event: {
        sessionId: string;
        userId: string;
        status: string;
        progress?: number;
        queuePosition?: number;
        error?: string;
        updatedAt: string;
        completedAt?: string;
    }) => void,
): EventSource {
    const url = `${BASE_URL}/saas/admin/sessions/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
        try {
            onEvent(JSON.parse(msg.data));
        } catch {
            // ignore parse errors
        }
    };
    return es;
}

// --- API Keys ---

export async function listUserKeys(token: string, userId: string) {
    return fetchApi(`/saas/admin/users/${userId}/keys`, token);
}

export async function revokeUserKey(
    token: string,
    userId: string,
    keyId: string,
) {
    return fetchApi(`/saas/admin/users/${userId}/keys/${keyId}`, token, {
        method: 'DELETE',
    });
}

// --- Dashboard ---

export async function getDashboard(token: string) {
    return fetchApi('/saas/admin/dashboard', token);
}
