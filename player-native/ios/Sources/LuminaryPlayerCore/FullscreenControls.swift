import Foundation

/// The rules of native full-screen, which copies `player-web`'s full-screen skin (plan 05):
/// what shows, when the controls hide, and what the time reads. The view draws what this says.
/// Imports no UIKit, so the rules run on virtual time in `swift test`.

/// What the controls are drawn from.
public struct FullscreenControlsState: Equatable {
    /// Playing, or about to: the viewer asked for playback.
    public var playing = false
    /// Waiting for data while playing.
    public var waiting = false
    /// The item is not ready to play yet: loading, or another just swapped in, before anything asked it to play.
    public var loading = false
    public var live = false
    /// The item has not said yet whether it is live or how long it is: a live stream reports an
    /// indefinite duration only once it is known, so until then nothing about seeking is shown.
    public var awaitingDuration = false
    /// Seconds; 0 until known.
    public var duration: Double = 0
    public var position: Double = 0
    /// How far is loaded, in seconds.
    public var loadedEnd: Double = 0
    public var rate: Double = 1
    public var muted = false
    public var audioTrackCount = 0
    public var hasSubtitles = false

    public init() {}
}

/// Which controls show, for a state.
public struct FullscreenControlsLayout: Equatable {
    /// Seconds per skip; nil hides the button.
    public let skipBack: Int?
    public let skipForward: Int?
    public let showsRate: Bool
    public let showsAudioMenu: Bool
    public let showsSubtitlesMenu: Bool
    /// The progress bar and the time; live shows `LIVE` instead.
    public let showsProgress: Bool
    /// In place of play/pause (native only).
    public let showsSpinner: Bool
    /// Pause while playing, play otherwise.
    public let showsPause: Bool

    public init(_ state: FullscreenControlsState, skin: SkinOptions) {
        // Live has nothing to skip to and no rate to change, and until it is known which this is,
        // neither is shown: a live stream would otherwise show them for a moment and take them away.
        let seekable = !state.live && !state.awaitingDuration
        skipBack = seekable ? skin.back : nil
        skipForward = seekable ? skin.forward : nil
        showsRate = seekable
        // video.js shows its audio button only with more than one track.
        showsAudioMenu = state.audioTrackCount > 1
        showsSubtitlesMenu = state.hasSubtitles
        showsProgress = seekable
        showsSpinner = state.loading || (state.playing && state.waiting)
        showsPause = state.playing
    }
}

/// The speeds `player-web` offers (`playerOptions.ts`).
public let fullscreenRates: [Double] = [0.5, 0.7, 1, 1.5]

/// AVPlayer keeps the rate as a float, so 0.7 comes back as 0.699999988: three decimals is what
/// the menu's speeds are compared to, and what JavaScript is told.
public func roundedRate(_ rate: Double) -> Double {
    (rate * 1000).rounded() / 1000
}

/// `1x`, `0.5x`, `1.5x`: video.js's rate label.
public func rateLabel(_ rate: Double) -> String {
    let rounded = (rate * 100).rounded() / 100
    return rounded == rounded.rounded() ? "\(Int(rounded))x" : "\(rounded)x"
}

/// video.js's `formatTime`: `m:ss`, with hours when `guide` (the duration) reaches an hour.
/// A negative time reads as 0; one that is not a number reads `-:-` (`-:-:-` with hours).
public func formatTime(_ seconds: Double, guide: Double) -> String {
    let guideWhole = guide.isFinite ? max(Int(guide), 0) : 0
    guard seconds.isFinite else { return guideWhole / 3600 > 0 ? "-:-:-" : "-:-" }
    let whole = Int(max(seconds, 0))
    let h = whole / 3600, m = (whole / 60) % 60, s = whole % 60
    let showHours = h > 0 || guideWhole / 3600 > 0
    let sText = s < 10 ? "0\(s)" : "\(s)"
    if showHours {
        let mText = m < 10 ? "0\(m)" : "\(m)"
        return "\(h):\(mText):\(sText)"
    }
    // Minutes are padded when the guide has ten or more of them, as video.js does.
    let mText = (guideWhole / 60) % 60 >= 10 && m < 10 ? "0\(m)" : "\(m)"
    return "\(mText):\(sText)"
}

/// The time row (native only): `0:07 / 2:00`, or `LIVE`.
public func timeText(_ state: FullscreenControlsState) -> String {
    if state.live { return "LIVE" }
    let duration = max(state.duration, state.position)
    return "\(formatTime(state.position, guide: duration)) / \(formatTime(duration, guide: duration))"
}

/// The time row's two ends: what has played, and what is left (`-1:53`), as the Video.js 10 skin
/// draws them either side of the bar. Whole seconds, so the two always add up to the length. A live
/// stream has only `LIVE`.
public func timeTexts(_ state: FullscreenControlsState) -> (elapsed: String, remaining: String) {
    if state.live { return ("LIVE", "") }
    let total = max(state.duration, state.position)
    let left = max(total.rounded(.down) - state.position.rounded(.down), 0)
    return (formatTime(state.position, guide: total), "-" + formatTime(left, guide: total))
}

/// When the controls show: `player-web`'s auto-hide (`vjs/autoHide.ts`). They hide 3 s after the
/// last touch while playing, and stay while paused. A tap on the picture while they show hides
/// them; while hidden, it shows them.
public final class FullscreenControlsVisibility {
    public static let hideAfter: Double = 3

    public private(set) var visible = true
    /// A roster is pinned open: the controls stay, whatever the viewer does, until it is closed.
    public var pinned = false {
        didSet {
            guard pinned != oldValue else { return }
            if pinned {
                timer?.cancel()
                set(true)
            } else {
                restart()
            }
        }
    }
    /// Called whenever ``visible`` changes.
    public var onChange: ((Bool) -> Void)?

    private let clock: Clock
    private var playing = false
    private var timer: Cancellable?

    public init(clock: Clock) {
        self.clock = clock
    }

    /// Any touch on a control: they stay, and the timer starts again.
    public func touched() {
        set(true)
        restart()
    }

    /// A tap on the picture itself.
    public func tappedPicture() {
        if visible, playing, !pinned {
            timer?.cancel()
            set(false)
        } else {
            touched()
        }
    }

    /// Playback started or stopped: paused, they show and stay.
    public func playbackChanged(playing: Bool) {
        guard playing != self.playing else { return }
        self.playing = playing
        if playing {
            restart()
        } else {
            timer?.cancel()
            set(true)
        }
    }

    /// A menu is open: nothing hides under the viewer's finger.
    public func hold() {
        timer?.cancel()
        set(true)
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    private func restart() {
        timer?.cancel()
        guard playing, !pinned else { return }
        timer = clock.schedule(Self.hideAfter) { [weak self] in self?.set(false) }
    }

    private func set(_ value: Bool) {
        guard value != visible else { return }
        visible = value
        onChange?(value)
    }
}

/// What the controls say to VoiceOver and in their menus: `player-web`'s `messages.ts` defaults,
/// with the labels video.js supplies itself for the controls `messages.ts` has none for.
public struct FullscreenTexts: Equatable {
    public var play = "Play"
    public var pause = "Pause"
    public var seek = "Seek"
    /// `{seconds}` is the interval.
    public var skipBack = "Skip back {seconds} seconds"
    public var skipForward = "Skip forward {seconds} seconds"
    public var exitFullscreen = "Exit full screen"
    public var audioMenu = "Audio"
    public var subtitlesMenu = "Subtitles"
    public var subtitlesOff = "Off"
    public var qualityMenu = "Quality"
    /// The player choosing for itself.
    public var qualityAuto = "Auto"
    public var pictureInPicture = "Picture-in-Picture"
    public var playbackRate = "Playback Rate"
    public var mute = "Mute"
    public var unmute = "Unmute"
    public var loading = "Loading"
    /// The panel's chapters tab.
    public var chapters = "Chapters"
    /// The panel's up-next tab, and the heading of the strip near the end.
    public var upNext = "Up next"
    /// The button that opens the chapters / up-next panel, and the panel itself.
    public var browse = "Chapters and up next"
    /// The panel's close button.
    public var closeBrowse = "Close"
    /// The line above the timeline; `{index}` and `{count}` are the chapter the playhead is in and how many there are.
    public var chapterOf = "Chapter {index} of {count}"
    /// The up-next strip's close button.
    public var dismiss = "Dismiss"

    public init() {}

    /// The English defaults, with the strings JavaScript sent over the top: the host's language.
    /// A key native does not know is ignored, one it was not given keeps its default.
    public init(overriding texts: [String: String]) {
        self.init()
        func take(_ key: String, into field: inout String) {
            if let value = texts[key], !value.isEmpty { field = value }
        }
        take("play", into: &play)
        take("pause", into: &pause)
        take("seek", into: &seek)
        take("skipBack", into: &skipBack)
        take("skipForward", into: &skipForward)
        take("exitFullscreen", into: &exitFullscreen)
        take("audioMenu", into: &audioMenu)
        take("subtitlesMenu", into: &subtitlesMenu)
        take("subtitlesOff", into: &subtitlesOff)
        take("qualityMenu", into: &qualityMenu)
        take("qualityAuto", into: &qualityAuto)
        take("pictureInPicture", into: &pictureInPicture)
        take("playbackRate", into: &playbackRate)
        take("mute", into: &mute)
        take("unmute", into: &unmute)
        take("loading", into: &loading)
        take("chapters", into: &chapters)
        take("upNext", into: &upNext)
        take("browse", into: &browse)
        take("closeBrowse", into: &closeBrowse)
        take("chapterOf", into: &chapterOf)
        take("dismiss", into: &dismiss)
    }

    public func skipBack(_ seconds: Int) -> String { skipBack.replacingOccurrences(of: "{seconds}", with: "\(seconds)") }
    public func skipForward(_ seconds: Int) -> String { skipForward.replacingOccurrences(of: "{seconds}", with: "\(seconds)") }
}
