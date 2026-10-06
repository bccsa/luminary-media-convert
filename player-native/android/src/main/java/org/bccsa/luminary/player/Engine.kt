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
    fun load(masterUri: String, startPosition: Double?, nowPlaying: NowPlaying?, recovery: RecoveryPolicy)

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

    fun enterFullscreen()

    fun exitFullscreen()

    fun destroy()

    var events: EventSink
}

/** Builds a player's engine over that player's [UriRouter]. */
fun interface EngineFactory {
    fun create(router: UriRouter, clock: Clock, options: CreateOptions): Engine
}
