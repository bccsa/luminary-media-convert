import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// The switch is module state, so each test loads a fresh copy.
const load = async () => {
    vi.resetModules();
    return import('./storage-outage');
};

describe('storage outage switch', () => {
    let server: http.Server;
    let port: number;
    /** Requests to /slow are answered only when released, to have one under way. */
    let release: (() => void) | undefined;

    beforeEach(async () => {
        server = http.createServer((req, res) => {
            if (req.url === '/slow') release = () => res.end('late');
            else res.end('ok');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        release?.();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    const get = (agent: http.Agent, path = '/') =>
        new Promise<string>((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve(body));
                res.on('error', reject);
            }).on('error', reject);
        });

    it('changes nothing unless the switch is allowed', async () => {
        const outage = await load();
        expect(outage.storageTransportAgent(false)).toBeUndefined();
        outage.setStorageOffline(true);
        expect(outage.storageOffline()).toBe(false);
    });

    it('refuses connections while offline, cuts the one under way, and connects again after', async () => {
        const outage = await load();
        outage.allowStorageOutageSwitch();
        const agent = outage.storageTransportAgent(false)!;
        expect(await get(agent)).toBe('ok');

        const underWay = get(agent, '/slow');
        await vi.waitFor(() => expect(release).toBeDefined());
        outage.setStorageOffline(true);
        await expect(underWay).rejects.toThrow();
        await expect(get(agent)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

        outage.setStorageOffline(false);
        expect(await get(agent)).toBe('ok');
    });

    it('gives every client the same agent for a scheme, so one switch reaches them all', async () => {
        const outage = await load();
        outage.allowStorageOutageSwitch();
        expect(outage.storageTransportAgent(true)).toBe(outage.storageTransportAgent(true));
        expect(outage.storageTransportAgent(true)).not.toBe(outage.storageTransportAgent(false));
    });
});
