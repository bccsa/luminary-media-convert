/// Every player, and the one entry point for a call. Main thread only.
///
/// Checks run in one order on every platform, and the first failure is the rejection: the
/// capability (`unsupported`), the arguments (`invalid-argument`), the player
/// (`unknown-player`), then the generation (`stale-generation`).
public final class PlayerRegistry {
    private let capabilities: BridgeCapabilities
    private let clock: Clock
    private let engineFactory: EngineFactory
    private let emit: EventSink.Emit

    /// Insertion order, so the oldest player is the first to go when `maxPlayers` is reached.
    private var players: [(id: String, host: PlayerHost)] = []
    private var destroyed: Set<String> = []
    private var created = 0

    /// The most recently created player, which the conformance harness drives and routes through.
    public private(set) var current: PlayerHost?

    public init(
        capabilities: BridgeCapabilities,
        clock: Clock,
        engineFactory: @escaping EngineFactory,
        emit: @escaping EventSink.Emit
    ) {
        self.capabilities = capabilities
        self.clock = clock
        self.engineFactory = engineFactory
        self.emit = emit
    }

    /// Resolves with the call's JSON answer, or throws a ``BridgeRejection``.
    public func call(_ method: String, _ args: [String: JSON]) throws -> JSON {
        if let needs = BridgeCall.capability(of: method), !capabilities[keyPath: needs] {
            throw BridgeRejection(.unsupported, "\(method) is not supported on this device")
        }
        return try handle(BridgeCall.decode(method, args))
    }

    private func handle(_ call: BridgeCall) throws -> JSON {
        switch call {
        case .getInfo:
            return .object([
                "protocolVersion": .number(Double(protocolVersion)),
                "platform": .string("ios"),
                "capabilities": capabilities.json,
            ])
        case .reset:
            for (id, _) in players { destroy(id) }
        case .create(let options):
            return try create(options)
        case .destroy(let playerId):
            if !destroyed.contains(playerId) {
                _ = try player(playerId)
                destroy(playerId)
            }
        default:
            return try handlePlayerCall(call, player(call.playerId!))
        }
        return .object([:])
    }

    private func handlePlayerCall(_ call: BridgeCall, _ player: PlayerHost) throws -> JSON {
        let generation: Int?
        switch call {
        case .load(let args): generation = args.generation
        case .putAssets(_, let value, _), .putLive(_, let value, _, _): generation = value
        default: generation = nil
        }
        if let generation, generation < player.generation {
            throw BridgeRejection(
                .staleGeneration,
                "generation \(generation) is older than \(player.generation)"
            )
        }

        let engine = player.engine
        switch call {
        case .load(let args): player.load(args)
        case .putAssets(_, let generation, let assets): player.putAssets(generation, assets)
        case .putLive(_, let generation, let uri, let spec): player.putLive(generation, uri, spec)
        case .releaseAssets(_, let generation): player.releaseAssets(generation)
        case .reattach(_, let loadId): player.reattach(loadId: loadId)
        case .play: engine.play()
        case .pause: engine.pause()
        case .seek(_, let position, let exact): engine.seek(position: position, exact: exact)
        case .setRate(_, let rate): engine.setRate(rate)
        case .setVariant(_, let id): engine.setVariant(id)
        case .setAudioTrack(_, let id): engine.setAudioTrack(id)
        case .enterFullscreen: engine.enterFullscreen()
        case .exitFullscreen: player.exitFullscreen()
        case .resumed: return player.resumed().json
        // Refused by its capability until phase 5 turns it on.
        case .warmChunks:
            throw BridgeRejection(.unsupported, "not implemented on this device")
        case .getInfo, .reset, .create, .destroy:
            preconditionFailure("handled by the registry")
        }
        return .object([:])
    }

    /// The app went to the background, or came back: every player hears it.
    public func setAppSuspended(_ suspended: Bool) {
        for (_, host) in players { host.setAppSuspended(suspended) }
    }

    private func create(_ options: CreateOptions) throws -> JSON {
        if options.protocolVersion != Double(protocolVersion) {
            throw BridgeRejection(
                .protocolMismatch,
                "protocol \(options.protocolVersion); this side speaks \(protocolVersion)"
            )
        }
        // A second create destroys the oldest player, silently.
        while players.count >= capabilities.maxPlayers, let oldest = players.first {
            destroy(oldest.id)
        }
        created += 1
        let playerId = "player-\(created)"
        let host = PlayerHost(
            playerId: playerId,
            clock: clock,
            variantSwitching: capabilities.variantSwitching,
            options: options,
            engineFactory: engineFactory,
            emit: emit
        )
        players.append((playerId, host))
        current = host
        return .object(["playerId": .string(playerId)])
    }

    private func player(_ playerId: String) throws -> PlayerHost {
        guard let host = players.first(where: { $0.id == playerId })?.host else {
            throw BridgeRejection(.unknownPlayer, "No player \(playerId)")
        }
        return host
    }

    private func destroy(_ playerId: String) {
        if let index = players.firstIndex(where: { $0.id == playerId }) {
            players.remove(at: index).host.destroy()
        }
        destroyed.insert(playerId)
    }
}
