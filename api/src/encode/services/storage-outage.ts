import * as http from 'node:http';
import * as https from 'node:https';
import { connect } from 'node:net';

/**
 * A development switch that cuts the encoder off from storage as a dropped
 * network would: new connections are refused and the ones open are cut, so the
 * failure, its message and the tries again are the real ones. Lets the network
 * cases be tested without taking the whole machine offline.
 *
 * Inert until {@link allowStorageOutageSwitch} is called before the first
 * storage client is made, which only the desktop shell's development build does.
 */
let allowed = false;
let offline = false;
const agents = new Map<boolean, http.Agent>();

export function allowStorageOutageSwitch(): void {
    allowed = true;
}

export function setStorageOffline(value: boolean): void {
    if (!allowed) return;
    offline = value;
    // Uploads under way fail too, as they do when the network goes.
    if (value) for (const agent of agents.values()) agent.destroy();
}

export function storageOffline(): boolean {
    return offline;
}

/** What a storage client should connect through: undefined, the default, unless the switch is allowed. */
export function storageTransportAgent(useSSL: boolean): http.Agent | undefined {
    if (!allowed) return undefined;
    let agent = agents.get(useSSL);
    if (!agent) {
        agent = useSSL
            ? new https.Agent({ keepAlive: true })
            : new http.Agent({ keepAlive: true });
        const create = agent.createConnection.bind(agent);
        // Port 9 on this machine has nothing listening, so the connection is
        // refused at once, with the same ECONNREFUSED a lost network gives.
        agent.createConnection = ((...args: Parameters<typeof create>) =>
            offline
                ? connect(9, '127.0.0.1')
                : create(...args)) as typeof agent.createConnection;
        agents.set(useSSL, agent);
    }
    return agent;
}
