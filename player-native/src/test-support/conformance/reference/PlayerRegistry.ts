/**
 * The reference `PlayerRegistry`, behind the decoding and validation
 * `LuminaryPlayerPlugin` does, and the {@link ConformanceHarness} over it.
 *
 * Checks run in one order on every platform: the capability (`unsupported`),
 * the arguments (`invalid-argument`), the player (`unknown-player`), then the
 * generation (`stale-generation`).
 */

import {
    ASSET_URI_PREFIX,
    PROTOCOL_VERSION,
    type BridgeAsset,
    type BridgeErrorCode,
    type InlineFrame,
} from '../../../bridge.js';
import type { CallResult, ConformanceHarness, RouteResult } from '../harness.js';
import type { Json, JsonObject } from '../scenario.js';
import { VirtualClock } from './clock.js';
import { PlayerHost } from './PlayerHost.js';

class Rejection extends Error {
    constructor(
        readonly code: BridgeErrorCode,
        message: string,
    ) {
        super(message);
    }
}

// ---------------------------------------------------------------------------
// Argument shapes, as bridge.ts declares them
// ---------------------------------------------------------------------------

type Shape =
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | { array: Shape }
    | { fields: Record<string, Shape>; optional?: Record<string, Shape> };

const ASSET: Shape = { fields: { uri: 'string', contentType: 'string', text: 'string' } };
const PLAYER = { playerId: 'string' } as const;

const SHAPES: Record<string, { fields: Record<string, Shape>; optional?: Record<string, Shape> }> = {
    getInfo: { fields: {} },
    reset: { fields: {} },
    create: { fields: { protocolVersion: 'number', skipBackSeconds: 'number', skipForwardSeconds: 'number' } },
    load: {
        fields: {
            ...PLAYER,
            loadId: 'string',
            generation: 'number',
            masterUri: 'string',
            assets: { array: ASSET },
            recovery: {
                fields: { escalationWindowMs: 'number', maxReloadAttempts: 'number', reloadDelaysMs: { array: 'number' } },
            },
        },
        optional: {
            keyHex: 'string',
            startPosition: 'number',
            nowPlaying: { fields: { title: 'string' }, optional: { subtitle: 'string', artworkUrl: 'string' } },
            requestHeaders: 'object',
        },
    },
    putAssets: { fields: { ...PLAYER, generation: 'number', assets: { array: ASSET } } },
    putLive: {
        fields: {
            ...PLAYER,
            generation: 'number',
            uri: 'string',
            spec: {
                fields: { url: 'string', baseUrl: 'string', refreshSec: 'number' },
                optional: { keyUri: 'string', keyHex: 'string' },
            },
        },
    },
    releaseAssets: { fields: { ...PLAYER, generation: 'number' } },
    reattach: { fields: { ...PLAYER, loadId: 'string' } },
    play: { fields: PLAYER },
    pause: { fields: PLAYER },
    seek: { fields: { ...PLAYER, position: 'number' }, optional: { exact: 'boolean' } },
    setRate: { fields: { ...PLAYER, rate: 'number' } },
    setVariant: { fields: { ...PLAYER, id: 'string' } },
    setAudioTrack: { fields: { ...PLAYER, id: 'string' } },
    warmChunks: {
        // ChunkBoundary[][]: an array of schedules, each an array of boundaries.
        fields: { ...PLAYER, loadId: 'string', schedules: { array: { array: 'object' } }, leadSeconds: 'number', warmBytes: 'number' },
    },
    setInlineFrame: {
        fields: PLAYER,
        optional: { frame: { fields: { x: 'number', y: 'number', width: 'number', height: 'number' } } },
    },
    enterFullscreen: { fields: PLAYER },
    exitFullscreen: { fields: PLAYER },
    resumed: { fields: PLAYER },
    destroy: { fields: PLAYER },
};

const KEY_HEX = /^[0-9a-f]{32}$/i;

function check(value: Json | undefined, shape: Shape, path: string): void {
    const fail = () => {
        throw new Rejection('invalid-argument', `${path} is not a valid ${typeof shape === 'string' ? shape : 'value'}`);
    };
    if (shape === 'string') {
        if (typeof value !== 'string') fail();
    } else if (shape === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail();
    } else if (shape === 'boolean') {
        if (typeof value !== 'boolean') fail();
    } else if (shape === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
    } else if ('array' in shape) {
        if (!Array.isArray(value)) return fail();
        value.forEach((item, i) => check(item, shape.array, `${path}[${i}]`));
    } else {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
        for (const [key, field] of Object.entries(shape.fields)) check(value[key], field, `${path}.${key}`);
        for (const [key, field] of Object.entries(shape.optional ?? {})) {
            if (value[key] !== undefined) check(value[key], field, `${path}.${key}`);
        }
    }
}

/** The rules a shape cannot say; each is `invalid-argument`. */
function checkValues(method: string, args: JsonObject): void {
    const invalid = (message: string) => {
        throw new Rejection('invalid-argument', message);
    };
    const generation = args.generation;
    if (typeof generation === 'number' && (!Number.isInteger(generation) || generation < 0)) {
        invalid('generation is a non-negative integer');
    }
    if (typeof args.keyHex === 'string' && !KEY_HEX.test(args.keyHex)) invalid('keyHex is 32 hex characters');
    if (typeof args.startPosition === 'number' && args.startPosition < 0) invalid('startPosition is not negative');
    if (method === 'seek' && (args.position as number) < 0) invalid('position is not negative');
    if (method === 'setRate' && !((args.rate as number) > 0)) invalid('rate is positive');
    if (method === 'setInlineFrame' && args.frame) {
        const frame = args.frame as Record<string, number>;
        if (!(frame.width > 0 && frame.height > 0)) invalid('frame has a positive width and height');
    }
    if (method === 'load' || method === 'putAssets') {
        const prefix = `${ASSET_URI_PREFIX}${String(generation)}/`;
        for (const asset of args.assets as unknown as BridgeAsset[]) {
            if (!asset.uri.startsWith(prefix)) invalid(`${asset.uri} is not an asset of generation ${String(generation)}`);
        }
        if (method === 'load' && !(args.masterUri as string).startsWith(ASSET_URI_PREFIX)) {
            invalid('masterUri is a luminary://asset/ address');
        }
    }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const CAPABILITY_OF: Record<string, string> = {
    setVariant: 'variantSwitching',
    putLive: 'live',
    warmChunks: 'chunkWarming',
    setInlineFrame: 'inlineVideo',
};

export class PlayerRegistry {
    private readonly players = new Map<string, PlayerHost>();
    private readonly destroyed = new Set<string>();
    private created = 0;
    /** The most recently created player, which the harness drives and routes through. */
    current: PlayerHost | null = null;

    constructor(
        private readonly capabilities: JsonObject,
        private readonly clock: VirtualClock,
        private readonly engineLog: JsonObject[],
        private readonly emit: (event: JsonObject) => void,
    ) {}

    call(method: string, args: JsonObject): JsonObject {
        const shape = SHAPES[method];
        if (!shape) throw new Error(`No bridge method ${method}`);
        const capability = CAPABILITY_OF[method];
        if (capability && this.capabilities[capability] !== true) {
            throw new Rejection('unsupported', `${method} needs ${capability}`);
        }
        check(args, shape, method);
        checkValues(method, args);

        switch (method) {
            case 'getInfo':
                return { protocolVersion: PROTOCOL_VERSION, platform: 'android', capabilities: this.capabilities };
            case 'reset':
                for (const id of [...this.players.keys()]) this.destroy(id);
                return {};
            case 'create':
                return this.create(args.protocolVersion as number);
            case 'destroy':
                if (!this.destroyed.has(args.playerId as string)) {
                    this.player(args);
                    this.destroy(args.playerId as string);
                }
                return {};
        }

        const player = this.player(args);
        const generation = args.generation as number | undefined;
        if (
            (method === 'load' || method === 'putAssets' || method === 'putLive') &&
            generation! < player.currentGeneration
        ) {
            throw new Rejection('stale-generation', `generation ${generation!} is older than ${player.currentGeneration}`);
        }

        switch (method) {
            case 'load':
                player.load(args as unknown as Parameters<PlayerHost['load']>[0]);
                break;
            case 'putAssets':
                player.putAssets(generation!, args.assets as unknown as BridgeAsset[]);
                break;
            case 'releaseAssets':
                player.releaseAssets(generation!);
                break;
            case 'reattach':
                player.reattach(args.loadId as string);
                break;
            case 'play':
                player.engine.play();
                break;
            case 'pause':
                player.engine.pause();
                break;
            case 'seek':
                player.engine.seek(args.position as number, (args.exact as boolean | undefined) ?? false);
                break;
            case 'setRate':
                player.engine.setRate(args.rate as number);
                break;
            case 'setVariant':
                player.engine.setVariant(args.id as string);
                break;
            case 'setAudioTrack':
                player.engine.setAudioTrack(args.id as string);
                break;
            case 'setInlineFrame':
                player.setInlineFrame((args.frame as InlineFrame | undefined) ?? null);
                break;
            case 'enterFullscreen':
                player.engine.enterFullscreen();
                break;
            case 'exitFullscreen':
                player.exitFullscreen();
                break;
            case 'resumed':
                return player.resumed();
            case 'putLive':
            case 'warmChunks':
                throw new Error(`${method}: arrives with its capability`);
        }
        return {};
    }

    private create(protocolVersion: number): JsonObject {
        if (protocolVersion !== PROTOCOL_VERSION) {
            throw new Rejection('protocol-mismatch', `protocol ${protocolVersion}; this side speaks ${PROTOCOL_VERSION}`);
        }
        const maxPlayers = this.capabilities.maxPlayers as number;
        while (this.players.size >= maxPlayers) this.destroy(this.players.keys().next().value!);
        const playerId = `player-${++this.created}`;
        const variantSwitching = this.capabilities.variantSwitching === true;
        const host = new PlayerHost(playerId, this.clock, this.engineLog, this.emit, variantSwitching);
        this.players.set(playerId, host);
        this.current = host;
        return { playerId };
    }

    private player(args: JsonObject): PlayerHost {
        const player = this.players.get(args.playerId as string);
        if (!player) throw new Rejection('unknown-player', `No player ${String(args.playerId)}`);
        return player;
    }

    private destroy(playerId: string): void {
        this.players.get(playerId)?.destroy();
        this.players.delete(playerId);
        this.destroyed.add(playerId);
    }

    static rejectionOf(error: unknown): { code: string; message: string } | null {
        return error instanceof Rejection ? { code: error.code, message: error.message } : null;
    }
}

/** The reference native side, behind the same seam the Kotlin and Swift runners drive. */
export class ReferenceHarness implements ConformanceHarness {
    private readonly clock = new VirtualClock();
    private events: JsonObject[] = [];
    private engineCalls: JsonObject[] = [];
    private registry: PlayerRegistry | null = null;

    start(capabilities: JsonObject): void {
        this.registry = new PlayerRegistry(capabilities, this.clock, this.engineCalls, (event) => this.events.push(event));
    }

    call(method: string, args: JsonObject): CallResult {
        try {
            return { resolved: this.started().call(method, args) };
        } catch (error) {
            const rejection = PlayerRegistry.rejectionOf(error);
            if (rejection) return { rejected: rejection };
            throw error;
        }
    }

    engine(signal: string, args: JsonObject): void {
        const player = this.started().current;
        if (!player) throw new Error('No engine: create a player first');
        player.engine.signal(signal, args);
    }

    advanceClock(seconds: number): void {
        this.clock.advance(seconds);
    }

    drainEvents(): JsonObject[] {
        return this.events.splice(0);
    }

    drainEngineCalls(): JsonObject[] {
        return this.engineCalls.splice(0);
    }

    route(uri: string): RouteResult {
        const player = this.started().current;
        return player ? player.router.route(uri) : { failed: 'not-found' };
    }

    private started(): PlayerRegistry {
        if (!this.registry) throw new Error('start the harness first');
        return this.registry;
    }
}
