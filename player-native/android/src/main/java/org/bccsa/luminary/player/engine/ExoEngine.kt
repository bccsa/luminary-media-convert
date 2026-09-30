package org.bccsa.luminary.player.engine

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.hls.HlsMediaSource
import kotlin.math.roundToLong
import org.bccsa.luminary.player.AudioTrack
import org.bccsa.luminary.player.Cancellable
import org.bccsa.luminary.player.Clock
import org.bccsa.luminary.player.CreateOptions
import org.bccsa.luminary.player.Engine
import org.bccsa.luminary.player.EventSink
import org.bccsa.luminary.player.Snapshot
import org.bccsa.luminary.player.UriRouter
import org.bccsa.luminary.player.Variant

/** The [Engine] on Media3 ExoPlayer: HLS through the player's [UriRouter], reported through [events]. */
@OptIn(UnstableApi::class)
class ExoEngine(
    context: Context,
    router: UriRouter,
    private val clock: Clock,
    options: CreateOptions,
    private val presenter: FullscreenPresenter,
    /** Tests pass a `TestExoPlayerBuilder`'s player; the app lets the engine build its own. */
    player: ExoPlayer? = null,
) : Engine, Player.Listener {
    override lateinit var events: EventSink

    private val player: ExoPlayer = player ?: ExoPlayer.Builder(context.applicationContext)
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            /* handleAudioFocus= */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .setSeekBackIncrementMs((options.skipBackSeconds * 1000).roundToLong().coerceAtLeast(1))
        .setSeekForwardIncrementMs((options.skipForwardSeconds * 1000).roundToLong().coerceAtLeast(1))
        .build()

    private val mediaSources = HlsMediaSource.Factory(router)
    private var mediaItem: MediaItem? = null
    private var metadataSent = false
    private var seekPending = false
    private var reportedAudio: Pair<List<AudioTrack>, String?>? = null
    private var reportedVariants: List<Variant>? = null
    private var reportedBufferedEnd = -1.0
    private var poll: Cancellable? = null

    /** The id `setVariant` pinned; re-applied to a rebuilt ladder that still offers it. */
    private var pinnedVariant: String? = null

    init {
        this.player.addListener(this)
    }

    override val hasVideo: Boolean
        get() = player.currentTracks.isEmpty || player.currentTracks.containsType(C.TRACK_TYPE_VIDEO)

    override fun load(masterUri: String, startPosition: Double?) {
        val item = MediaItem.Builder().setUri(masterUri).setMimeType(MimeTypes.APPLICATION_M3U8).build()
        mediaItem = item
        beginItem()
        // The controller hands its audio choice back once the new list arrives.
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
            .build()
        val source = mediaSources.createMediaSource(item)
        if (startPosition != null) {
            player.setMediaSource(source, (startPosition * 1000).roundToLong())
        } else {
            player.setMediaSource(source, /* resetPosition= */ true)
        }
        player.prepare()
        startPolling()
    }

    /** The same item again, prepared from scratch; rate and track parameters live on the player. */
    override fun reattach() {
        val item = mediaItem ?: return
        val position = player.currentPosition
        beginItem()
        player.setMediaSource(mediaSources.createMediaSource(item), position)
        player.prepare()
        startPolling()
    }

    private fun beginItem() {
        metadataSent = false
        seekPending = false
        reportedAudio = null
        reportedVariants = null
        reportedBufferedEnd = -1.0
    }

    override fun play() = player.play()

    override fun pause() = player.pause()

    override fun seek(position: Double, exact: Boolean) {
        player.setSeekParameters(if (exact) SeekParameters.EXACT else SeekParameters.CLOSEST_SYNC)
        player.seekTo((position * 1000).roundToLong())
    }

    override fun setRate(rate: Double) = player.setPlaybackSpeed(rate.toFloat())

    override fun setVariant(id: String) {
        pinnedVariant = id.takeUnless { it == "auto" }
        if (!applyVariantPin(player.currentTracks)) {
            // A rendition this device cannot play (or no longer offers) falls back to auto.
            events.variants(reportedVariants ?: emptyList())
        }
    }

    /** Pins [pinnedVariant] if [tracks] offer it, else clears the pin; false when a pin was dropped. */
    private fun applyVariantPin(tracks: Tracks): Boolean {
        val pinned = pinnedVariant
        val builder = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_VIDEO)
        if (pinned == null) {
            player.trackSelectionParameters = builder.build()
            return true
        }
        for (group in tracks.groups) {
            if (group.type != C.TRACK_TYPE_VIDEO) continue
            for (i in 0 until group.length) {
                if (group.isTrackSupported(i) && variantOf(group.getTrackFormat(i)).id == pinned) {
                    val override = TrackSelectionOverride(group.mediaTrackGroup, i)
                    player.trackSelectionParameters = builder.setOverrideForType(override).build()
                    return true
                }
            }
        }
        // Before the ladder is known, keep the pin for when it arrives.
        if (tracks.isEmpty) return true
        pinnedVariant = null
        player.trackSelectionParameters = builder.build()
        return false
    }

    override fun setAudioTrack(id: String) {
        for (group in player.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                if (audioIdOf(group.getTrackFormat(i), i) == id) {
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, i))
                        .build()
                    return
                }
            }
        }
    }

    override fun snapshot(): Snapshot {
        val state = player.playbackState
        return Snapshot(
            currentTime = player.currentPosition / 1000.0,
            duration = duration(),
            bufferedEnd = player.bufferedPosition / 1000.0,
            playing = player.playWhenReady && (state == Player.STATE_BUFFERING || state == Player.STATE_READY),
        )
    }

    /** 0 until known; null while unbounded (live). */
    private fun duration(): Double? {
        if (player.isCurrentMediaItemLive) return null
        val duration = player.duration
        return if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0
    }

    override fun enterFullscreen() {
        if (presenter.present(player, onLeave = ::leaveFullscreenByViewer)) events.presentationChanged("fullscreen")
    }

    override fun exitFullscreen() {
        if (presenter.dismiss()) events.presentationChanged("inline")
    }

    /** The back gesture or the exit button leaves full-screen the way `exitFullscreen` does, pause included. */
    private fun leaveFullscreenByViewer() {
        exitFullscreen()
        if (hasVideo) player.pause()
    }

    override fun destroy() {
        poll?.cancel()
        poll = null
        presenter.dismiss()
        player.removeListener(this)
        player.release()
    }

    // The buffered end, sampled on the main looper; EventSink holds `progress` to 1 Hz.

    private fun startPolling() {
        if (poll != null) return
        poll = clock.schedule(POLL_PERIOD, ::sample)
    }

    private fun sample() {
        val end = player.bufferedPosition / 1000.0
        if (metadataSent && end != reportedBufferedEnd) {
            reportedBufferedEnd = end
            events.bufferedTo(end)
        }
        poll = clock.schedule(POLL_PERIOD, ::sample)
    }

    // Player.Listener: what ExoPlayer reports, handed to EventSink.

    override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        if (timeline.isEmpty) return
        if (metadataSent) events.durationChanged(duration()) else announceMetadata()
    }

    /** Once per load, when the duration is known (or known to be unbounded). */
    private fun announceMetadata() {
        val duration = duration()
        if (metadataSent || duration == 0.0) return
        metadataSent = true
        events.readyToPlay(duration)
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_BUFFERING -> if (player.playWhenReady) events.buffering()
            Player.STATE_READY -> {
                announceMetadata()
                if (seekPending) {
                    seekPending = false
                    events.seeked()
                }
            }
            Player.STATE_ENDED -> events.ended()
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) events.playing()
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (!playWhenReady && reason != Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) events.paused()
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        // A seek masks the state to BUFFERING; it has finished once the player is READY again.
        if (reason == Player.DISCONTINUITY_REASON_SEEK) seekPending = true
    }

    override fun onTracksChanged(tracks: Tracks) {
        val audio = mutableListOf<AudioTrack>()
        var activeAudio: String? = null
        val variants = mutableListOf<Variant>()
        for (group in tracks.groups) {
            for (i in 0 until group.length) {
                if (!group.isTrackSupported(i)) continue
                val format = group.getTrackFormat(i)
                when (group.type) {
                    C.TRACK_TYPE_AUDIO -> {
                        val id = audioIdOf(format, i)
                        audio += AudioTrack(id, format.language, format.label ?: format.language ?: id)
                        if (group.isTrackSelected(i)) activeAudio = id
                    }
                    C.TRACK_TYPE_VIDEO -> variants += variantOf(format)
                }
            }
        }

        // The empty list on load / reattach is PlayerHost's; the engine reports only a real one.
        if (audio.isNotEmpty() && reportedAudio != audio to activeAudio) {
            reportedAudio = audio to activeAudio
            events.audioTracks(audio, activeAudio)
        }
        val pinHeld = applyVariantPin(tracks)
        if (variants.isNotEmpty() && (variants != reportedVariants || !pinHeld)) {
            reportedVariants = variants
            events.variants(variants)
        }
    }

    override fun onPlayerError(error: PlaybackException) {
        // Fatal at once until phase 3 puts the recovery ladder in front of it.
        events.error(categoryOf(error), fatal = true, code = error.errorCodeName, message = error.message ?: error.errorCodeName)
    }

    private companion object {
        const val POLL_PERIOD = 0.25

        fun variantOf(format: Format): Variant {
            val height = format.height.takeIf { it != Format.NO_VALUE }
            val bandwidth = (format.peakBitrate.takeIf { it != Format.NO_VALUE } ?: format.bitrate)
                .takeIf { it != Format.NO_VALUE }?.toLong() ?: 0L
            return Variant("${height ?: 0}_$bandwidth", height, bandwidth)
        }

        /** HLS names an audio rendition `<GROUP-ID>:<NAME>`, which survives a reattach. */
        fun audioIdOf(format: Format, index: Int): String = format.id ?: "audio-$index"
    }
}
