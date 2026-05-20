export interface CouchdbAuth {
    username: string;
    password: string;
}

export interface CouchdbConfig {
    url: string;
    dbName: string;
    auth?: CouchdbAuth;
}

export function buildCouchdbUrl(): CouchdbConfig {
    const rawUrl = process.env.COUCHDB_URL || 'http://localhost:5984';
    const username = process.env.COUCHDB_USERNAME;
    const password = process.env.COUCHDB_PASSWORD;
    const dbName = process.env.COUCHDB_DATABASE || 'luminary';

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(
            `Invalid COUCHDB_URL: ${rawUrl}. Expected a host-only URL such as http://localhost:5984.`,
        );
    }

    if (parsed.username || parsed.password) {
        throw new Error(
            'COUCHDB_URL must not contain embedded credentials. Set COUCHDB_USERNAME and COUCHDB_PASSWORD env vars instead, and use a host-only URL (e.g. http://localhost:5984).',
        );
    }

    if (username && !password) {
        throw new Error(
            'COUCHDB_USERNAME is set but COUCHDB_PASSWORD is empty.',
        );
    }
    if (password && !username) {
        throw new Error(
            'COUCHDB_PASSWORD is set but COUCHDB_USERNAME is empty.',
        );
    }

    const result: CouchdbConfig = { url: parsed.toString(), dbName };

    if (username && password) {
        // Pass credentials through nano's requestDefaults.auth (forwarded to
        // axios) instead of embedding them in the URL. Axios builds the Basic
        // Auth header from the raw username/password, so every byte — including
        // ':', '@', '%', '(', '.' — reaches CouchDB exactly as configured.
        // URL-embedded userinfo would arrive percent-encoded and not match the
        // stored password.
        result.auth = { username, password };
    }

    return result;
}
