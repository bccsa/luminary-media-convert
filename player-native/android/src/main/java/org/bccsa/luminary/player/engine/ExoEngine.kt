package org.bccsa.luminary.player.engine

import android.app.PendingIntent
import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToLong
import android.util.Log
import java.net.InetAddress
import org.bccsa.luminary.player.AudioTrack
import org.bccsa.luminary.player.CastServer
import org.bccsa.luminary.player.Cancellable
import org.bccsa.luminary.player.Clock
import org.bccsa.luminary.player.CreateOptions
import org.bccsa.luminary.player.Engine
import org.bccsa.luminary.player.EventSink
import org.bccsa.luminary.player.InlineFrame
import org.bccsa.luminary.player.NowPlaying
import org.bccsa.luminary.player.PendingReload
import org.bccsa.luminary.player.RecoveryLadder
import org.bccsa.luminary.player.RecoveryPolicy
import org.bccsa.luminary.player.Snapshot
import org.bccsa.luminary.player.UriRouter
import org.bccsa.luminary.player.rewriteForCast
import org.bccsa.luminary.player.Variant

/** The [Engine] on Media3 ExoPlayer: HLS through the player's [UriRouter], reported through [events]. */
@OptIn(UnstableApi::class)
class ExoEngine(
    context: Context,
    private val router: UriRouter,
    private val clock: Clock,
    options: CreateOptions,
    private val presenter: FullscreenPresenter,
    /** Tests pass a `TestExoPlayerBuilder`'s player; the app lets the engine build its own. */
    player: ExoPlayer? = null,
    /** Whether the app is in the foreground; tests pass their own. */
    private val appLifecycle: Lifecycle = ProcessLifecycleOwner.get().lifecycle,
    /** The picture shown in the page; null where there is no web view to put it behind. */
    private val inline: InlinePresenter? = null,
    /** Google Cast, where the host and the device allow it; null otherwise. */
    private val cast: CastSupport? = null,
    /** The phone's address on the Wi-Fi, which a receiver on the same network can reach; null when there is none. */
    private val castAddress: () -> InetAddress? = { CastServer.lanAddress() },
) : Engine, Player.Listener {
    override lateinit var events: EventSink

    /** What the full-screen controls and the notification skip by; snapped onto what the skin can draw. */
    private val skin = SkinOptions(options.skipBackSeconds, options.skipForwardSeconds)

    /** Seeds the adaptive logic from the host's connection measure; only the player this engine builds takes it. */
    private val bandwidth: SeedableBandwidthMeter? =
        if (player == null) SeedableBandwidthMeter(DefaultBandwidthMeter.getSingletonInstance(context.applicationContext)) else null

    private val player: ExoPlayer = player ?: ExoPlayer.Builder(context.applicationContext)
        .setBandwidthMeter(bandwidth!!)
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            /* handleAudioFocus= */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        // The screen may lock mid-stream; the Wi-Fi has to stay up for the next segment.
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .setSeekBackIncrementMs((skin.back ?: DEFAULT_SKIP_SECONDS) * 1000L)
        .setSeekForwardIncrementMs((skin.forward ?: DEFAULT_SKIP_SECONDS) * 1000L)
        .build()

    /**
     * The system's view of this player: the lock screen and the media notification, with skip
     * buttons that jump by the same seconds the full-screen controls do. [PlaybackService] hosts
     * it, which is what keeps it playing with the screen locked.
     */
    private val session: MediaSession = MediaSession.Builder(context.applicationContext, this.player)
        .setId("luminary-player-${SESSIONS.incrementAndGet()}")
        .setMediaButtonPreferences(skipButtons(skin))
        .setCallback(SessionCallback)
        .apply { openAppIntent(context.applicationContext)?.let(::setSessionActivity) }
        .build()

    private val appContext = context.applicationContext

    /** In the background only the sound is wanted: the video track goes, and its downloads with it. */
    private val appVisibility = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            // The phone's picture stays off while the TV has it.
            if (castPlayer == null) setVideoDisabled(false)
            setAppSuspended(false)
        }

        override fun onStop(owner: LifecycleOwner) {
            setVideoDisabled(true)
            setAppSuspended(true)
        }
    }

    /** The system-facing session, for tests to read what the lock screen would be offered. */
    internal val mediaSession: MediaSession get() = session

    /** The policy of the source being loaded; the loader's retries and the ladder both read it. */
    private var recovery = RecoveryPolicy.DEFAULT

    private val mediaSources = HlsMediaSource.Factory(router)
        .setLoadErrorHandlingPolicy(TransientRetryPolicy { recovery })

    /** Before playback is declared over: ExoPlayer's own retries, then this (plan 02, phase 3). */
    private val ladder = RecoveryLadder(
        recovery,
        clock,
        object : RecoveryLadder.Hooks {
            // ExoPlayer leaves the player idle on a fatal error; prepare() resumes from where it stopped.
            override fun recoverInPlace(category: String): Boolean {
                this@ExoEngine.player.prepare()
                return true
            }

            override fun reattach() = this@ExoEngine.reattach()

            override fun requestReload(reason: RecoveryLadder.Reason, attempt: Int) =
                events.reloadRequested(reason.wire, attempt)

            override fun onExhausted(failure: RecoveryLadder.Failure) {
                // Full-screen would hold a frozen picture: the viewer is taken back to the page,
                // where the host shows the error and the way to try again.
                exitFullscreen()
                events.error(failure.category, fatal = true, code = failure.code, message = failure.message)
            }
        },
    )
    private var stalled = false
    private var wasReady = false
    private var mediaItem: MediaItem? = null
    private var metadataSent = false
    private var seekPending = false
    private var reportedAudio: Pair<List<AudioTrack>, String?>? = null
    private var reportedVariants: List<Variant>? = null
    private var reportedBufferedEnd = -1.0
    private var poll: Cancellable? = null

    /** The id `setVariant` pinned; re-applied to a rebuilt ladder that still offers it. */
    private var pinnedVariant: String? = null

    /** The receiver's player while playback is on a TV; null while it is on the phone. */
    private var castPlayer: Player? = null

    /** A receiver session that is up, taken over as soon as there is something to play. */
    private var availableCast: Player? = null
    private var castServer: CastServer? = null

    /** Playback commands, state and events are the receiver's while casting. */
    private val active: Player get() = castPlayer ?: player

    /** What the receiver's player says that the page needs to hear: playback, never its tracks or volume. */
    private val castForwarder = object : Player.Listener {
        override fun onTimelineChanged(timeline: Timeline, reason: Int) = handleTimelineChanged(timeline)

        override fun onPlaybackStateChanged(playbackState: Int) {
            Log.d("LuminaryCast", "receiver state=$playbackState")
            handlePlaybackStateChanged(playbackState)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) = handleIsPlayingChanged(isPlaying)

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = handlePlayWhenReadyChanged(playWhenReady, reason)

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) =
            handlePositionDiscontinuity(reason)

        override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) = handleParameters(playbackParameters)

        // The receiver gave up: the TV is not a reason to lose the viewer's place, so playback comes home.
        override fun onPlayerError(error: PlaybackException) {
            Log.w("LuminaryCast", "receiver error ${error.errorCodeName} (${error.errorCode}): ${error.message}", error)
            endCasting()
        }
    }

    init {
        this.player.addListener(this)
        appLifecycle.addObserver(appVisibility)
        // Casting is an extra: whatever goes wrong in the Cast SDK must never stop the player from existing.
        runCatching {
            cast?.start(object : CastSupport.Listener {
                override fun routesChanged(available: Boolean, active: Boolean) {
                    if (::events.isInitialized) events.airPlayChanged(available, active)
                }

                override fun sessionAvailable(player: Player) {
                    availableCast = player
                    startCasting(player)
                }

                override fun sessionLost() {
                    Log.d("LuminaryCast", "session lost")
                    availableCast = null
                    endCasting()
                }
            })
        }
        // A new surface in the page has nothing drawn in it, and a finished item draws nothing by itself.
        inline?.onSurfaceCreated = { if (presentation == "inline") redrawEndedFrame() }
        // A phone turned to landscape while the page shows the picture opens it full-screen.
        inline?.onRotatedToLandscape = {
            if (inlineFrame != null && presentation == "inline" && hasVideo) enterFullscreen(null)
        }
    }

    private fun setVideoDisabled(disabled: Boolean) {
        if (player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_VIDEO) == disabled) return
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, disabled)
            .build()
    }

    /** Whether the video track is off because the app is in the background, for tests. */
    internal val videoDisabled: Boolean
        get() = player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_VIDEO)

    override val hasVideo: Boolean
        get() = player.currentTracks.isEmpty || player.currentTracks.containsType(C.TRACK_TYPE_VIDEO)

    override fun load(
        masterUri: String,
        startPosition: Double?,
        nowPlaying: NowPlaying?,
        recovery: RecoveryPolicy,
        bandwidthEstimate: Double?,
    ) {
        bandwidth?.hint = bandwidthEstimate?.toLong()
        this.recovery = recovery
        ladder.setPolicy(recovery)
        ladder.noteSourceLoaded()
        val item = MediaItem.Builder()
            .setUri(masterUri)
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .setMediaMetadata(metadataOf(nowPlaying))
            .build()
        mediaItem = item
        beginItem()
        PlaybackService.host(appContext, session)
        // The controller hands its audio choice back once the new list arrives.
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            // The page's subtitle choice is the truth: off until it picks one, whatever the master's default says.
            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setPreferredAudioLanguage(null)
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
        // A session that was up before there was anything to play takes this over; one that is up
        // already gets the new source in place of the old.
        val receiver = castPlayer
        if (receiver != null) {
            player.playWhenReady = false
            castItem(item)?.let { receiver.setMediaItem(it, ((startPosition ?: 0.0) * 1000).roundToLong()) }
            receiver.prepare()
        } else {
            availableCast?.let(::startCasting)
        }
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

    override fun setAppSuspended(suspended: Boolean) = ladder.setAppSuspended(suspended)

    override fun takeHeldReload(): PendingReload? = ladder.takeHeldReload()

    private fun beginItem() {
        stalled = false
        wasReady = false
        metadataSent = false
        seekPending = false
        reportedAudio = null
        reportedVariants = null
        reportedBufferedEnd = -1.0
    }

    /** As a video element does: playing at the end starts again from the beginning. */
    override fun play() {
        Util.handlePlayButtonAction(active)
    }

    override fun pause() = active.pause()

    override fun seek(position: Double, exact: Boolean) {
        if (castPlayer == null) player.setSeekParameters(if (exact) SeekParameters.EXACT else SeekParameters.CLOSEST_SYNC)
        active.seekTo((position * 1000).roundToLong())
    }

    override fun setRate(rate: Double) = active.setPlaybackSpeed(rate.toFloat())

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

    /** The volume to give back on unmute. */
    private var volumeBeforeMute = 1f

    override fun setMuted(muted: Boolean) {
        if (muted) {
            if (player.volume > 0f) volumeBeforeMute = player.volume
            player.volume = 0f
        } else if (player.volume == 0f) {
            player.volume = volumeBeforeMute
        }
    }

    override fun setSubtitleTrack(label: String?) = selectSubtitle(player, label)

    /** Needs the system's picture in picture and an activity that allows it; the registry refuses the call otherwise. */
    /** The system's list of Cast devices (or, when connected, its controller). The capability is off where there is no Cast. */
    override fun showAirPlayPicker() {
        runCatching { cast?.showPicker() }
    }

    override fun startPictureInPicture() {
        if (!hasVideo || castPlayer != null) return
        // The small window shows the full-screen view's picture: take the picture there first.
        if (!presenter.isPresented) enterFullscreen(null)
        presenter.startPictureInPicture()
    }

    /** Where the page shows the picture, while it does. */
    private var inlineFrame: InlineFrame? = null

    override fun setInlineFrame(frame: InlineFrame?) {
        inlineFrame = frame
        inline?.setFrame(frame, player)
    }

    /** `inline`, `fullscreen` or `pip`: whichever of the last two holds the picture, the page's view has none. */
    private var presentation = "inline"

    private fun presentationDidChange(state: String) {
        presentation = state
        inline?.setSuspended(state != "inline")
        events.presentationChanged(state)
        // Whichever view has the picture now was given a surface with nothing drawn in it.
        if (state == "fullscreen" || (state == "inline" && inlineFrame != null)) redrawEndedFrame()
    }

    /** Set while the re-seek below runs, so the `ended` it leads back to is not reported a second time. */
    private var redrawing = false

    /**
     * A finished item has no frame in a surface it was just given: ExoPlayer draws none until
     * something moves. Seeking to where it already is draws the last one, and says nothing to the page.
     */
    private fun redrawEndedFrame() {
        if (player.playbackState != Player.STATE_ENDED) return
        redrawing = true
        player.seekTo(player.currentPosition)
    }

    override fun setAudioTrack(id: String) {
        val choice = audioChoicesOf(player.currentTracks).firstOrNull { it.id == id } ?: return
        selectAudio(player, choice)
    }

    override fun snapshot(): Snapshot {
        val state = active.playbackState
        return Snapshot(
            currentTime = active.currentPosition / 1000.0,
            duration = duration(),
            bufferedEnd = active.bufferedPosition / 1000.0,
            playing = active.playWhenReady && (state == Player.STATE_BUFFERING || state == Player.STATE_READY),
        )
    }

    /** 0 until known; null while unbounded (live). */
    private fun duration(): Double? {
        if (active.isCurrentMediaItemLive) return null
        val duration = active.duration
        return if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0
    }

    /** What the full-screen controls say; the host's language once it has sent it. */
    private var texts = FullscreenTexts()

    override fun enterFullscreen(texts: Map<String, String>?) {
        // A call with no texts keeps the last, or English.
        if (texts != null) this.texts = FullscreenTexts.from(texts)
        // The picture is on the TV: there is nothing to show full-screen here.
        if (castPlayer != null) return
        // Audio-only has no view. Until the tracks are known the item is presumed to have one, and
        // the view is taken down again if it turns out not to (see `onTracksChanged`).
        if (knownAudioOnly(player.currentTracks)) return
        if (presenter.present(player, ::leaveFullscreenByViewer, skin, this.texts, ::presentationDidChange)) {
            presentationDidChange("fullscreen")
        }
    }

    private fun knownAudioOnly(tracks: Tracks) = !tracks.isEmpty && !tracks.containsType(C.TRACK_TYPE_VIDEO)

    override fun exitFullscreen() {
        if (presenter.dismiss()) presentationDidChange("inline")
    }

    /**
     * The back gesture or the exit button leaves full-screen the way `exitFullscreen` does, pause
     * included, unless the video is shown in the page: it plays on there.
     */
    private fun leaveFullscreenByViewer() {
        exitFullscreen()
        if (hasVideo && inlineFrame == null) player.pause()
    }

    override fun destroy() {
        runCatching { cast?.stop() }
        castPlayer?.removeListener(castForwarder)
        castPlayer = null
        runCatching { castServer?.close() }
        castServer = null
        ladder.destroy()
        poll?.cancel()
        poll = null
        presenter.dismiss()
        inline?.destroy()
        appLifecycle.removeObserver(appVisibility)
        player.removeListener(this)
        PlaybackService.release(session)
        session.release()
        player.release()
    }

    // The buffered end, sampled on the main looper; EventSink holds `progress` to 1 Hz.

    private fun startPolling() {
        if (poll != null) return
        poll = clock.schedule(POLL_PERIOD, ::sample)
    }

    private fun sample() {
        val end = active.bufferedPosition / 1000.0
        if (metadataSent && end != reportedBufferedEnd) {
            reportedBufferedEnd = end
            events.bufferedTo(end)
        }
        poll = clock.schedule(POLL_PERIOD, ::sample)
    }

    // Player.Listener: what ExoPlayer reports, handed to EventSink.

    override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        if (castPlayer == null) handleTimelineChanged(timeline)
    }

    private fun handleTimelineChanged(timeline: Timeline) {
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
        if (castPlayer == null) handlePlaybackStateChanged(playbackState)
    }

    private fun handlePlaybackStateChanged(playbackState: Int) {
        val ready = wasReady
        wasReady = playbackState == Player.STATE_READY || (playbackState == Player.STATE_BUFFERING && ready)
        when (playbackState) {
            Player.STATE_BUFFERING -> if (active.playWhenReady) {
                events.buffering()
                // Running dry mid-playback is the engine's own verdict; a seek or a first load is not.
                if (wasReady && !seekPending) stall()
            }
            Player.STATE_READY -> {
                announceMetadata()
                if (seekPending) {
                    seekPending = false
                    events.seeked()
                }
            }
            Player.STATE_ENDED -> if (redrawing) {
                redrawing = false
                seekPending = false
            } else {
                events.ended()
            }
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (castPlayer == null) handleIsPlayingChanged(isPlaying)
    }

    private fun handleIsPlayingChanged(isPlaying: Boolean) {
        if (!isPlaying) return
        ladder.notePlaybackHealthy()
        clearStall()
        events.playing()
    }

    private fun stall() {
        if (stalled) return
        stalled = true
        events.stalled(true)
    }

    private fun clearStall() {
        if (!stalled) return
        stalled = false
        events.stalled(false)
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (castPlayer == null) handlePlayWhenReadyChanged(playWhenReady, reason)
    }

    private fun handlePlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (!playWhenReady && reason != Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) events.paused()
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (castPlayer == null) handlePositionDiscontinuity(reason)
    }

    private fun handlePositionDiscontinuity(reason: Int) {
        // A seek masks the state to BUFFERING; it has finished once the player is READY again.
        if (reason == Player.DISCONTINUITY_REASON_SEEK && !redrawing) seekPending = true
    }

    override fun onTracksChanged(tracks: Tracks) {
        if (presenter.isPresented && knownAudioOnly(tracks)) {
            presenter.dismiss()
            presentationDidChange("inline")
        }
        val choices = audioChoicesOf(tracks)
        val audio = choices.map { AudioTrack(it.id, it.language, it.label) }
        val activeAudio = choices.firstOrNull { it.selected }?.id
        val variants = mutableListOf<Variant>()
        for (group in tracks.groups) {
            if (group.type != C.TRACK_TYPE_VIDEO) continue
            for (i in 0 until group.length) {
                if (group.isTrackSupported(i)) variants += variantOf(group.getTrackFormat(i))
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

    override fun onVolumeChanged(volume: Float) {
        if (volume > 0f) volumeBeforeMute = volume
        events.mutedChanged(volume == 0f)
    }

    override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
        if (castPlayer == null) handleParameters(playbackParameters)
    }

    private fun handleParameters(playbackParameters: PlaybackParameters) {
        events.rateChanged(rateOf(playbackParameters.speed))
    }

    override fun onPlayerError(error: PlaybackException) {
        // The phone's own player is silent while the TV has playback; its trouble is for when it is back.
        if (castPlayer != null) return
        ladder.note(
            RecoveryLadder.Failure(
                category = categoryOf(error),
                code = error.errorCodeName,
                message = error.message ?: error.errorCodeName,
                needsRebuild = needsRebuild(error),
            ),
        )
    }

    /** Only this app and the system's own controllers may drive the session; nothing is resumed after a reboot. */
    private object SessionCallback : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
            if (controller.isTrusted) super.onConnect(session, controller) else MediaSession.ConnectionResult.reject()

        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
            Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume: the app picks what plays"))
    }

    // Casting.

    /** The receiver's item for [item]: the master's address on the phone's own server, which the TV can reach. */
    private fun castItem(item: MediaItem): MediaItem? {
        val base = castServer?.base ?: return null
        val uri = item.localConfiguration?.uri?.toString() ?: return null
        return MediaItem.Builder()
            .setUri(rewriteForCast(uri, base))
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .setMediaMetadata(item.mediaMetadata)
            .build()
    }

    /**
     * Moves playback to the receiver: the phone's player goes quiet where it is (keeping its source
     * and tracks, so the page's lists stay), the phone starts answering for the playlists and key a
     * TV cannot reach, and the TV is given the master from there at the same position.
     */
    private fun startCasting(receiver: Player) {
        val item = mediaItem ?: return
        if (castPlayer != null) return
        val address = castAddress()
        if (address == null) {
            Log.w(TAG, "No Wi-Fi address to serve a cast from")
            return
        }
        val server = CastServer(router, address)
        try {
            server.start()
        } catch (failed: java.io.IOException) {
            Log.w(TAG, "Could not start the cast server: ${failed.message}")
            return
        }
        castServer = server

        val wanted = player.playWhenReady && player.playbackState != Player.STATE_ENDED
        val position = player.currentPosition
        val speed = player.playbackParameters.speed
        // The TV has the picture now: nothing full-screen here, and from here the phone's events are ignored.
        if (presenter.dismiss()) presentationDidChange("inline")
        castPlayer = receiver
        receiver.addListener(castForwarder)
        player.pause()
        setVideoDisabled(true)

        castItem(item)?.let { receiver.setMediaItem(it, position) }
        receiver.setPlaybackSpeed(speed)
        receiver.prepare()
        receiver.playWhenReady = wanted
    }

    /** Brings playback home from the receiver, at the place it had got to. */
    private fun endCasting() {
        val receiver = castPlayer ?: return
        val position = receiver.currentPosition
        val wanted = receiver.playWhenReady && receiver.playbackState != Player.STATE_ENDED
        receiver.removeListener(castForwarder)
        runCatching {
            receiver.stop()
            receiver.clearMediaItems()
        }
        castPlayer = null
        runCatching { castServer?.close() }
        castServer = null
        if (appLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) setVideoDisabled(false)
        player.seekTo(position)
        player.playWhenReady = wanted
    }

    private companion object {
        /** What a re-attach cannot fix: a decoder that will not start, an asset the source no longer names. */
        fun needsRebuild(error: PlaybackException) = error.errorCode in listOf(
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
        )

        private const val TAG = "LuminaryCast"
        const val POLL_PERIOD = 0.25
        const val DEFAULT_SKIP_SECONDS = 10

        /** A media session's id must be unique in the process, and a player may be created again. */
        val SESSIONS = AtomicInteger()

        /** Seek back / forward on the notification and lock screen, labelled with the skin's seconds. */
        fun skipButtons(skin: SkinOptions): List<CommandButton> = listOfNotNull(
            skin.back?.let { seconds ->
                CommandButton.Builder(
                    when (seconds) {
                        5 -> CommandButton.ICON_SKIP_BACK_5
                        10 -> CommandButton.ICON_SKIP_BACK_10
                        else -> CommandButton.ICON_SKIP_BACK_30
                    },
                ).setPlayerCommand(Player.COMMAND_SEEK_BACK).setDisplayName("Back $seconds seconds").build()
            },
            skin.forward?.let { seconds ->
                CommandButton.Builder(
                    when (seconds) {
                        5 -> CommandButton.ICON_SKIP_FORWARD_5
                        10 -> CommandButton.ICON_SKIP_FORWARD_10
                        else -> CommandButton.ICON_SKIP_FORWARD_30
                    },
                ).setPlayerCommand(Player.COMMAND_SEEK_FORWARD).setDisplayName("Forward $seconds seconds").build()
            },
        )

        /** Tapping the notification brings the app back. */
        fun openAppIntent(context: Context): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        fun variantOf(format: Format): Variant {
            val height = format.height.takeIf { it != Format.NO_VALUE }
            val bandwidth = (format.peakBitrate.takeIf { it != Format.NO_VALUE } ?: format.bitrate)
                .takeIf { it != Format.NO_VALUE }?.toLong() ?: 0L
            return Variant("${height ?: 0}_$bandwidth", height, bandwidth)
        }

        /** The session reads the item's metadata for the lock screen; it fetches the artwork itself. */
        fun metadataOf(nowPlaying: NowPlaying?): MediaMetadata {
            if (nowPlaying == null) return MediaMetadata.EMPTY
            return MediaMetadata.Builder()
                .setTitle(nowPlaying.title)
                .setDisplayTitle(nowPlaying.title)
                .setArtist(nowPlaying.subtitle)
                .setSubtitle(nowPlaying.subtitle)
                .setArtworkUri(nowPlaying.artworkUrl?.let(Uri::parse))
                .build()
        }

        /**
         * ExoPlayer keeps the speed as a float, so 0.7 reads back as 0.699999988; rounded, it is
         * the number JavaScript asked for, which is how it recognises the answer to its own call.
         */
        fun rateOf(speed: Float): Double = Math.round(speed * 1000.0) / 1000.0
    }
}

/**
 * ExoPlayer retries one failed request a couple of times before it fails the load, spaced by the
 * policy's own delays. The ladder starts only when that has failed, so the retries stay short.
 */
@OptIn(UnstableApi::class)
private class TransientRetryPolicy(private val policy: () -> RecoveryPolicy) : DefaultLoadErrorHandlingPolicy() {
    override fun getMinimumLoadableRetryCount(dataType: Int): Int = minOf(policy().maxReloadAttempts, MAX_LOADER_RETRIES)

    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val retry = super.getRetryDelayMsFor(loadErrorInfo)
        if (retry == C.TIME_UNSET) return retry
        val delays = policy().reloadDelaysMs
        if (delays.isEmpty()) return retry
        return delays[minOf(maxOf(loadErrorInfo.errorCount - 1, 0), delays.size - 1)].toLong()
    }

    private companion object {
        const val MAX_LOADER_RETRIES = 2
    }
}
