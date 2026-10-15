package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One player: its [AssetStore], [KeyHolder], [UriRouter], [Engine] and [EventSink]. Main thread only. */
class PlayerHost(
    val playerId: String,
    private val clock: Clock,
    variantSwitching: Boolean,
    upstream: HttpUpstream?,
    options: CreateOptions,
    engineFactory: EngineFactory,
    liveFetch: LiveFetch?,
    private val warmFetch: WarmFetch,
    emit: (name: String, payload: JsonObject) -> Unit,
) {
    private val assets = AssetStore()
    private val key = KeyHolder()
    val router = if (liveFetch != null) UriRouter(assets, key, upstream, liveFetch) else UriRouter(assets, key, upstream)
    private val sink = EventSink(playerId, clock, variantSwitching, emit) { engine.snapshot().currentTime }
    val engine: Engine = engineFactory.create(router, clock, options).also { it.events = sink }

    var generation = 0
        private set
    private var loadId: String? = null

    /** Warms the current load's chunks; a new load gets a new one, a reattach keeps it. */
    private var warmer: ChunkWarmer? = null

    /** Where the video is shown inside the page, while it is. */
    private var inlineFrame: InlineFrame? = null

    /** Assets → key → engine; the generations it replaces are purged once the engine has the new one. */
    fun load(args: LoadArgs) {
        generation = args.generation
        // A new source: whatever was warming belongs to the one it replaces.
        warmer?.stop()
        warmer = null
        assets.put(args.generation, args.assets)
        key.set(args.keyHex)
        beginLoad(args.loadId)
        engine.setSourceCastable(isCastable(args.assets))
        engine.load(args.masterUri, args.startPosition, args.nowPlaying, args.recovery, args.bandwidthEstimate)
        engine.setThumbnails(args.thumbnailsUrl, this.key.copy())
        assets.purgeReleasedBefore(args.generation)
    }

    /**
     * Google's receiver plays fragmented-MP4 HLS well and transport-stream HLS badly (long stalls,
     * or an error), so only a source whose playlists carry an init segment offers casting.
     */
    private fun isCastable(assets: List<BridgeAsset>) = assets.any { it.text.contains("#EXT-X-MAP") }

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

    fun putLive(generation: Int, uri: String, spec: BridgeLiveSpec) = assets.putLive(generation, uri, LiveSpec.of(spec))

    /** For the current load only: a call for one it replaced is ignored. */
    fun warmChunks(loadId: String, schedules: JsonArray, leadSeconds: Double, warmBytes: Int) {
        if (loadId != this.loadId) return
        val boundaries = ChunkBoundary.schedules(schedules)
        val warmer = warmer ?: ChunkWarmer(
            clock,
            {
                val snapshot = engine.snapshot()
                maxOf(snapshot.bufferedEnd, snapshot.currentTime)
            },
            warmFetch,
        ).also { warmer = it }
        warmer.start(boundaries, leadSeconds, warmBytes)
    }

    fun releaseAssets(generation: Int) = assets.release(generation)

    fun setInlineFrame(frame: InlineFrame?) {
        inlineFrame = frame
        engine.setInlineFrame(frame)
    }

    /**
     * Pauses, unless the item has no video (audio keeps playing when full-screen goes away) or its
     * video is shown in the page, where it plays on.
     */
    fun exitFullscreen() {
        engine.exitFullscreen()
        if (engine.hasVideo && inlineFrame == null) engine.pause()
    }

    fun resumed(): ResumeResult = ResumeResult(loadId, engine.snapshot(), pendingReload = engine.takeHeldReload())

    fun destroy() {
        warmer?.stop()
        warmer = null
        sink.close()
        key.zero()
        assets.clear()
        engine.destroy()
    }
}
