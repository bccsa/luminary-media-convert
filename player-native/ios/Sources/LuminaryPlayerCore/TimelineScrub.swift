import Foundation

/// The timeline under a finger: a tap does not move the video, it opens the way to scrub it. With frames that is the
/// strip of them; without, a thicker bar with a handle. Only a drag moves the playhead. The video holds still while
/// either is open, and they put themselves away a few seconds after the last touch, on a tap elsewhere or on play,
/// the video carrying on only if it was playing when they opened. `player-web` and the Android player keep the same
/// rules.
public final class TimelineScrub {
    /// What a touch on the timeline has opened.
    public enum Mode: Equatable {
        case closed
        /// The strip of frames.
        case strip
        /// No frames to show: the bar itself, thicker and with a handle.
        case bar
    }

    /// What the player has to do about it.
    public enum Effect: Equatable {
        case open(Mode)
        case close
        case pause
        case play
        case seek(Double)
    }

    /// How long after the last touch it closes on its own.
    public static let idleSeconds: Double = 3

    public private(set) var mode: Mode = .closed
    public var isOpen: Bool { mode != .closed }
    public var onEffect: ((Effect) -> Void)?

    private let clock: Clock
    private var resumeOnClose = false
    private var idle: Cancellable?

    public init(clock: Clock) {
        self.clock = clock
    }

    /// A finger came down on the timeline or the strip: nothing closes under it.
    public func touchBegan() {
        idle?.cancel()
        idle = nil
    }

    /// A tap on the timeline, which never moves the video.
    public func tapped(framesReady: Bool, playing: Bool) {
        openIfClosed(framesReady: framesReady, playing: playing)
        armIdle()
    }

    /// A drag on the timeline or the strip started.
    public func dragBegan(framesReady: Bool, playing: Bool) {
        openIfClosed(framesReady: framesReady, playing: playing)
        touchBegan()
    }

    /// The drag let go at `seconds`: the one place the video moves.
    public func dragEnded(at seconds: Double) {
        onEffect?(.seek(seconds))
        armIdle()
    }

    /// The drag was taken away from the finger without a decision: nothing moves.
    public func dragCancelled() {
        armIdle()
    }

    /// A tap anywhere but the timeline and the strip.
    public func tappedElsewhere() {
        close(resume: true)
    }

    /// Play was asked for while open: it closes, and the video plays whether or not it was before.
    public func playPressed() {
        guard isOpen else { return }
        resumeOnClose = true
        close(resume: true)
    }

    /// A new video, or the player going away: put away without touching playback.
    public func reset() {
        close(resume: false)
    }

    private func openIfClosed(framesReady: Bool, playing: Bool) {
        guard mode == .closed else { return }
        resumeOnClose = playing
        mode = framesReady ? .strip : .bar
        onEffect?(.open(mode))
        if playing { onEffect?(.pause) }
    }

    private func armIdle() {
        idle?.cancel()
        guard isOpen else { return }
        idle = clock.schedule(Self.idleSeconds) { [weak self] in self?.close(resume: true) }
    }

    private func close(resume: Bool) {
        idle?.cancel()
        idle = nil
        guard isOpen else { return }
        mode = .closed
        onEffect?(.close)
        if resume, resumeOnClose { onEffect?(.play) }
        resumeOnClose = false
    }
}
