package org.bccsa.luminary.spike

import android.content.Context
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import java.io.IOException
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient
import org.bccsa.luminary.player.AssetStore
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.KeyHolder
import org.bccsa.luminary.player.UriRouter

/**
 * One ExoPlayer, fed the bridge's payload the way `PlayerHost` feeds `ExoEngine`: assets into the
 * store, the key into memory, then the master through the plugin's [UriRouter].
 */
@OptIn(UnstableApi::class)
class SpikePlayer(context: Context, val payload: Payload?, private val log: (String) -> Unit) : AnalyticsListener {
    /** How the master reaches ExoPlayer — the Android counterpart of iOS's content-type question. */
    enum class Mode(val label: String) {
        /** `HlsMediaSource.Factory` over the router, as `ExoEngine` does it. */
        HLS("hls"),

        /** `DefaultMediaSourceFactory`, told the MIME type. */
        MIME("mime"),

        /** `DefaultMediaSourceFactory`, left to infer HLS from a `luminary://…/n.m3u8` URI. */
        INFER("infer"),
    }

    var mode = Mode.HLS

    private val bandwidthMeter = DefaultBandwidthMeter.Builder(context).build()
    val player: ExoPlayer = ExoPlayer.Builder(context).setBandwidthMeter(bandwidthMeter).build()
    private val http = HttpUpstream(OkHttpClient())
    private val requests = RequestLog(log)
    private var assets = AssetStore()
    private var key = KeyHolder()
    private var router = UriRouter(assets, key, http)

    private var loadStartedAt = 0L
    private var firstFrameMs: Long? = null
    private var droppedFrames = 0
    private var videoFormat: Format? = null
    private var loggedTracks: String? = null

    init {
        player.addAnalyticsListener(this)
        payload?.let(::describe)
    }

    /** Everything a new generation needs: a fresh store and the key. */
    fun reset() {
        key.zero()
        assets = AssetStore()
        key = KeyHolder().apply { set(payload?.keyHex) }
        router = UriRouter(assets, key, http)
    }

    /** Plays one visit: its assets join the store, as `load` does within a generation. */
    fun play(visit: Payload.Visit, positionMs: Long) {
        val payload = payload ?: return
        val putStarted = SystemClock.elapsedRealtime()
        assets.put(visit.generation, visit.assets)
        val putMs = SystemClock.elapsedRealtime() - putStarted

        val factory = requests.wrap(router)
        val item = MediaItem.Builder()
            .setUri(visit.masterUri)
            .apply { if (mode == Mode.MIME) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .build()
        val source = when (mode) {
            Mode.HLS -> HlsMediaSource.Factory(factory).createMediaSource(item)
            Mode.MIME, Mode.INFER ->
                DefaultMediaSourceFactory(DataSource.Factory { factory.createDataSource(C.DATA_TYPE_UNKNOWN) })
                    .createMediaSource(item)
        }

        requests.begin()
        firstFrameMs = null
        droppedFrames = 0
        loggedTracks = null
        loadStartedAt = SystemClock.elapsedRealtime()
        log("load    ${payload.name(visit)} mode=${mode.label} assets=+${visit.assets.size} (stored in $putMs ms) at ${positionMs} ms")
        player.setMediaSource(source, positionMs)
        player.prepare()
        player.play()
    }

    fun stop() {
        player.stop()
        player.clearMediaItems()
    }

    /** Milliseconds from [play] to the first rendered frame (or, with no video, the playhead moving). */
    suspend fun waitForFirstFrame(audioOnly: Boolean, timeoutMs: Long): Long? {
        val start = player.currentPosition
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            if (audioOnly) {
                if (player.playbackState == Player.STATE_READY && player.currentPosition - start > 100) return elapsed()
            } else {
                firstFrameMs?.let { return it }
            }
            delay(10)
        }
        return null
    }

    fun dumpStats(label: String) {
        val video = videoFormat?.let { "${it.width}x${it.height} peak=${it.peakBitrate}" } ?: "none"
        log("stats   $label ${requests.summary()}, estimate=${bandwidthMeter.bitrateEstimate} bps, video=$video, dropped=$droppedFrames, buffered=${player.totalBufferedDuration / 1000} s")
    }

    private fun elapsed() = SystemClock.elapsedRealtime() - loadStartedAt

    /** The payload's shape, and how its playlists state the key and IV (the step-0 IV question). */
    private fun describe(payload: Payload) {
        log("payload ${payload.visits.size} visits of ${payload.masterUrl}, ${payload.bytes / 1024} KiB, key=${if (payload.keyHex != null) "yes" else "no"}")
        payload.visits.forEach { visit ->
            val bytes = visit.assets.sumOf { it.text.length }
            log("  ${payload.name(visit)}: ${visit.assets.size} assets, ${bytes / 1024} KiB of text")
        }
        val keyTags = payload.visits.flatMap { it.assets }.flatMap { it.text.lineSequence().filter { line -> line.startsWith("#EXT-X-KEY") }.toList() }
        if (keyTags.isNotEmpty()) {
            val withIv = keyTags.count { "IV=" in it }
            val methods = keyTags.mapNotNull { Regex("METHOD=([A-Z0-9-]+)").find(it)?.groupValues?.get(1) }.distinct()
            val uris = keyTags.mapNotNull { Regex("URI=\"([^\"]+)\"").find(it)?.groupValues?.get(1) }.distinct()
            log("keys    ${keyTags.size} #EXT-X-KEY tags, METHOD=$methods, URI=$uris, explicit IV in $withIv")
        }
    }

    // AnalyticsListener: what ExoPlayer did, logged.

    override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
        val name = when (state) {
            Player.STATE_IDLE -> "idle"
            Player.STATE_BUFFERING -> "buffering"
            Player.STATE_READY -> "ready"
            else -> "ended"
        }
        log("player  $name at ${elapsed()} ms")
    }

    override fun onIsPlayingChanged(eventTime: AnalyticsListener.EventTime, isPlaying: Boolean) {
        log("player  ${if (isPlaying) "playing" else "not playing"} at ${elapsed()} ms")
    }

    override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
        if (firstFrameMs != null) return
        firstFrameMs = elapsed()
        log("frame   first frame rendered after ${firstFrameMs} ms")
    }

    override fun onTracksChanged(eventTime: AnalyticsListener.EventTime, tracks: Tracks) {
        val lines = mutableListOf<String>()
        for (group in tracks.groups) {
            for (i in 0 until group.length) {
                val format = group.getTrackFormat(i)
                val supported = if (group.isTrackSupported(i)) "ok" else "UNSUPPORTED"
                val selected = if (group.isTrackSelected(i)) " *" else ""
                when (group.type) {
                    C.TRACK_TYPE_VIDEO ->
                        lines += "tracks  video ${format.width}x${format.height} ${format.codecs} peak=${format.peakBitrate} $supported$selected"
                    C.TRACK_TYPE_AUDIO ->
                        lines += "tracks  audio ${format.id} lang=${format.language} ${format.codecs} ch=${format.channelCount} $supported$selected"
                    C.TRACK_TYPE_TEXT ->
                        lines += "tracks  text ${format.id} lang=${format.language} ${format.sampleMimeType} $supported$selected"
                }
            }
        }
        val text = lines.joinToString("\n")
        if (lines.isEmpty() || text == loggedTracks) return
        loggedTracks = text
        lines.forEach(log)
    }

    override fun onVideoInputFormatChanged(
        eventTime: AnalyticsListener.EventTime,
        format: Format,
        decoderReuseEvaluation: DecoderReuseEvaluation?,
    ) {
        videoFormat = format
        log("format  video ${format.width}x${format.height} peak=${format.peakBitrate} ${format.codecs} at ${elapsed()} ms, estimate=${bandwidthMeter.bitrateEstimate}")
    }

    override fun onAudioInputFormatChanged(
        eventTime: AnalyticsListener.EventTime,
        format: Format,
        decoderReuseEvaluation: DecoderReuseEvaluation?,
    ) {
        log("format  audio ${format.id} lang=${format.language} ${format.codecs} at ${elapsed()} ms")
    }

    override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
        this.droppedFrames += droppedFrames
    }

    override fun onLoadError(
        eventTime: AnalyticsListener.EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData,
        error: IOException,
        wasCanceled: Boolean,
    ) {
        log("error   load ${loadEventInfo.uri}: ${error.javaClass.simpleName} ${error.message}")
    }

    override fun onPlayerError(eventTime: AnalyticsListener.EventTime, error: PlaybackException) {
        var text = "${error.errorCodeName}: ${error.message}"
        var cause = error.cause
        while (cause != null) {
            text += " <- ${cause.javaClass.simpleName}: ${cause.message}"
            cause = cause.cause
        }
        log("error   PLAYER $text")
    }

    // Autorun.

    /** The step-0 run: for each mode, play the first angle, switch to every other visit, summarise. */
    suspend fun autorun(secondsPerVisit: Long) {
        val payload = payload ?: return
        player.volume = 0f
        val summary = mutableListOf<String>()
        for (mode in Mode.entries) {
            this.mode = mode
            reset()
            payload.visits.forEachIndexed { index, visit ->
                play(visit, if (index == 0) 0 else player.currentPosition)
                val name = payload.name(visit)
                val ms = waitForFirstFrame(visit.audioOnly, timeoutMs = 20_000)
                summary += "${mode.label} $name: ${ms?.let { "first frame in $it ms" } ?: "NO FRAME"}"
                delay(secondsPerVisit * 1000)
                dumpStats("${mode.label}/$name")
            }
            stop()
        }
        player.volume = 1f
        log("summary")
        summary.forEach { log("  $it") }
        log("done")
    }

    fun release() {
        key.zero()
        player.release()
    }
}
