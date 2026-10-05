/// One player: its ``AssetStore``, ``KeyHolder``, ``UriRouter``, ``Engine`` and ``EventSink``.
/// Main thread only.
public final class PlayerHost {
    public let playerId: String
    public let router: UriRouter
    public let engine: Engine
    public private(set) var generation = 0

    private let assets: AssetStore
    private let key: KeyHolder
    private let sink: EventSink
    private var loadId: String?

    init(
        playerId: String,
        clock: Clock,
        variantSwitching: Bool,
        options: CreateOptions,
        engineFactory: EngineFactory,
        emit: @escaping EventSink.Emit
    ) {
        let assets = AssetStore()
        let key = KeyHolder()
        let router = UriRouter(assets: assets, key: key)
        let engine = engineFactory(router, clock, options)
        self.playerId = playerId
        self.assets = assets
        self.key = key
        self.router = router
        self.engine = engine
        sink = EventSink(
            playerId: playerId,
            clock: clock,
            variantSwitching: variantSwitching,
            emit: emit,
            position: { [weak engine] in engine?.snapshot().currentTime ?? 0 }
        )
        engine.events = sink
    }

    /// Assets → key → engine; the generations it replaces are purged once the engine has the
    /// new one.
    func load(_ args: LoadArgs) {
        generation = args.generation
        assets.put(args.generation, args.assets)
        key.set(hex: args.keyHex)
        beginLoad(args.loadId)
        engine.load(
            masterUri: args.masterUri,
            startPosition: args.startPosition,
            nowPlaying: args.nowPlaying,
            recovery: args.recovery
        )
        assets.purgeReleased(before: args.generation)
    }

    func reattach(loadId: String) {
        beginLoad(loadId)
        engine.reattach()
    }

    /// Every load and reattach starts with an empty track list, stamped with the new load.
    private func beginLoad(_ loadId: String) {
        self.loadId = loadId
        sink.begin(loadId: loadId)
        sink.audioTracks([], activeId: nil)
    }

    func putAssets(_ generation: Int, _ assets: [BridgeAsset]) {
        self.assets.put(generation, assets)
    }

    func putLive(_ generation: Int, _ uri: String, _ spec: BridgeLiveSpec) {
        assets.putLive(generation, uri, spec)
    }

    func releaseAssets(_ generation: Int) {
        assets.release(generation)
    }

    /// Pauses, unless the item has no video: audio keeps playing when full-screen goes away.
    func exitFullscreen() {
        engine.exitFullscreen()
        if engine.hasVideo { engine.pause() }
    }

    func resumed() -> ResumeResult {
        ResumeResult(loadId: loadId, snapshot: engine.snapshot(), pendingReload: engine.takeHeldReload())
    }

    func setAppSuspended(_ suspended: Bool) {
        engine.setAppSuspended(suspended)
    }

    func destroy() {
        sink.close()
        key.zero()
        assets.clear()
        engine.destroy()
    }
}
