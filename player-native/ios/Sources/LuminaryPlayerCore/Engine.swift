/// The only AVFoundation seam, the same on Android. Commands arrive on the main thread in the
/// order JavaScript sent them; everything the engine has to say goes through ``events``.
public protocol Engine: AnyObject {
    /// `nowPlaying` is what the lock screen and Control Center show for the item.
    func load(masterUri: String, startPosition: Double?, nowPlaying: NowPlaying?)

    /// Same assets; restore position, rate and tracks.
    func reattach()

    func play()
    func pause()
    func seek(position: Double, exact: Bool)
    func setRate(_ rate: Double)

    /// `"auto"` clears the pin. Only called when `variantSwitching`.
    func setVariant(_ id: String)

    func setAudioTrack(_ id: String)
    func snapshot() -> Snapshot

    /// False for an audio-only item, which keeps playing when full-screen is left.
    var hasVideo: Bool { get }

    func enterFullscreen()
    func exitFullscreen()
    func destroy()

    var events: EventSink? { get set }
}

/// Builds a player's engine over that player's ``UriRouter``.
public typealias EngineFactory = (UriRouter, Clock, CreateOptions) -> Engine
