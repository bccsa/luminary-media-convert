package org.bccsa.luminary.player

/**
 * The only Media3 seam, the same on iOS. Commands arrive on the main thread in the order JavaScript
 * sent them; everything the engine has to say goes through [events].
 */
interface Engine {
    /**
     * [nowPlaying] is what the lock screen and the notification show for this item; [recovery] is
     * the policy the recovery ladder climbs by.
     */
    fun load(
        masterUri: String,
        startPosition: Double?,
        nowPlaying: NowPlaying?,
        recovery: RecoveryPolicy,
        /** The host's connection measure in bits per second, to start the adaptive logic from; null for none. */
        bandwidthEstimate: Double?,
    )

    /** Same assets; restore position, rate and tracks. */
    fun reattach()

    fun play()

    fun pause()

    fun seek(position: Double, exact: Boolean)

    fun setRate(rate: Double)

    /** `"auto"` clears the pin. Only called when `variantSwitching`. */
    fun setVariant(id: String)

    fun setAudioTrack(id: String)

    fun snapshot(): Snapshot

    /** False for an audio-only item, which keeps playing when full-screen is left. */
    val hasVideo: Boolean

    /**
     * The app went to the background (true) or came back (false). JavaScript is frozen in the
     * background, so a reload asked for then is held for [takeHeldReload].
     */
    fun setAppSuspended(suspended: Boolean)

    /** The reload held while the app was in the background, handed over once; `resumed()` returns it. */
    fun takeHeldReload(): PendingReload?

    /** Mutes or unmutes; reported as `mutedchange` whoever changes it. */
    fun setMuted(muted: Boolean)

    /** Selects the subtitle listed under [label] (its name, else its language); null turns them off. */
    fun setSubtitleTrack(label: String?)

    /** Opens the system's AirPlay device list. Android has none, and does not report the capability. */
    fun showAirPlayPicker()

    /** The angles and qualities the TV's menu offers while casting, with the page's current choice. */
    fun setCastMenu(menu: CastMenu) {}

    /** Starts picture in picture from the picture that is showing; nothing when none is. */
    fun startPictureInPicture()

    /** Shows the video in the page, in this frame of the web view, or hides it (null). */
    fun setInlineFrame(frame: InlineFrame?)

    /** [texts] are what the controls say, in the host's language; null keeps the last, or English. */
    fun enterFullscreen(texts: Map<String, String>?)

    fun exitFullscreen()

    fun destroy()

    var events: EventSink
}

/** Builds a player's engine over that player's [UriRouter]. */
fun interface EngineFactory {
    fun create(router: UriRouter, clock: Clock, options: CreateOptions): Engine
}
