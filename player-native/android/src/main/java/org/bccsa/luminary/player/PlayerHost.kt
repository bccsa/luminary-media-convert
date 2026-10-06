package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonObject

/** One player: its [AssetStore], [KeyHolder], [UriRouter], [Engine] and [EventSink]. Main thread only. */
class PlayerHost(
    val playerId: String,
    clock: Clock,
    variantSwitching: Boolean,
    upstream: HttpUpstream?,
    options: CreateOptions,
    engineFactory: EngineFactory,
    emit: (name: String, payload: JsonObject) -> Unit,
) {
    private val assets = AssetStore()
    private val key = KeyHolder()
    val router = UriRouter(assets, key, upstream)
    private val sink = EventSink(playerId, clock, variantSwitching, emit) { engine.snapshot().currentTime }
    val engine: Engine = engineFactory.create(router, clock, options).also { it.events = sink }

    var generation = 0
        private set
    private var loadId: String? = null

    /** Assets → key → engine; the generations it replaces are purged once the engine has the new one. */
    fun load(args: LoadArgs) {
        generation = args.generation
        assets.put(args.generation, args.assets)
        key.set(args.keyHex)
        beginLoad(args.loadId)
        engine.load(args.masterUri, args.startPosition, args.nowPlaying, args.recovery)
        assets.purgeReleasedBefore(args.generation)
    }

    fun reattach(loadId: String) {
        beginLoad(loadId)
        engine.reattach()
    }

    /** Every load and reattach starts with an empty track list, stamped with the new load. */
    private fun beginLoad(loadId: String) {
        this.loadId = loadId
        sink.begin(loadId)
        sink.audioTracks(emptyList(), null)
    }

    fun putAssets(generation: Int, assets: List<BridgeAsset>) = this.assets.put(generation, assets)

    fun releaseAssets(generation: Int) = assets.release(generation)

    /** Pauses, unless the item has no video: audio keeps playing when full-screen goes away. */
    fun exitFullscreen() {
        engine.exitFullscreen()
        if (engine.hasVideo) engine.pause()
    }

    fun resumed(): ResumeResult = ResumeResult(loadId, engine.snapshot(), pendingReload = engine.takeHeldReload())

    fun destroy() {
        sink.close()
        key.zero()
        assets.clear()
        engine.destroy()
    }
}
