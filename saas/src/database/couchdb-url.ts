export interface CouchdbConfig {
    url: string;
    dbName: string;
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

    if (username && password) {
        // encodeURIComponent first so bare '%' characters become '%25'. The
        // WHATWG URL setter passes valid '%XX' sequences through unchanged
        // (it won't double-encode), but on its own does NOT escape a bare '%'
        // — which would leave the URL malformed.
        parsed.username = encodeURIComponent(username);
        parsed.password = encodeURIComponent(password);
    }

    return { url: parsed.toString(), dbName };
}
