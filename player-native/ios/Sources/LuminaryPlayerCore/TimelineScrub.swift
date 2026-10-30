import Foundation

/// The timeline under a finger: a tap does not move the video, it opens the way to scrub it. With frames that is the
/// strip of them; without, a thicker bar with a handle. Only a drag moves the playhead, and only a drag holds the
/// video: it carries on from where the finger let go if it was playing when the drag began. They put themselves away
/// a few seconds after the last touch, on a tap elsewhere or on play. `player-web` and the Android player keep the
/// same rules.
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
    public static let idleSeconds: Double = 5

    public private(set) var mode: Mode = .closed
    public var isOpen: Bool { mode != .closed }
    public var onEffect: ((Effect) -> Void)?

    private let clock: Clock
    private var dragging = false
    private var resumeAfterDrag = false
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
    public func tapped(framesReady: Bool) {
        openIfClosed(framesReady: framesReady)
        armIdle()
    }

    /// A drag on the timeline or the strip started: the video holds still under the finger.
    public func dragBegan(framesReady: Bool, playing: Bool) {
        openIfClosed(framesReady: framesReady)
        touchBegan()
        guard !dragging else { return }
        dragging = true
        resumeAfterDrag = playing
        if playing { onEffect?(.pause) }
    }

    /// The drag let go at `seconds`: the one place the video moves.
    public func dragEnded(at seconds: Double) {
        onEffect?(.seek(seconds))
        endDrag(resume: true)
        armIdle()
    }

    /// The drag was taken away from the finger without a decision: nothing moves.
    public func dragCancelled() {
        endDrag(resume: true)
        armIdle()
    }

    /// A tap anywhere but the timeline and the strip.
    public func tappedElsewhere() {
        close(resume: true)
    }

    /// Play was asked for while open: it closes, and the video plays whether or not it was before.
    public func playPressed() {
        guard isOpen else { return }
        close(resume: false)
        onEffect?(.play)
    }

    /// A new video, or the player going away: put away without touching playback.
    public func reset() {
        close(resume: false)
    }

    private func openIfClosed(framesReady: Bool) {
        guard mode == .closed else { return }
        mode = framesReady ? .strip : .bar
        onEffect?(.open(mode))
    }

    private func endDrag(resume: Bool) {
        guard dragging else { return }
        dragging = false
        if resume, resumeAfterDrag { onEffect?(.play) }
        resumeAfterDrag = false
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
        endDrag(resume: resume)
    }
}
