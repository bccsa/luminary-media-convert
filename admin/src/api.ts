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
