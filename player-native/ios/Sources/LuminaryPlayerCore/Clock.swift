import Foundation

/// A timer that can be called off.
public protocol Cancellable {
    func cancel()
}

/// The time every timer in ``PlayerHost`` and ``EventSink`` runs on, so tests can run them on
/// virtual time. The app's clock is monotonic, so a wall-clock change cannot bunch or starve the
/// emission timers.
public protocol Clock: AnyObject {
    /// Seconds on a monotonic clock.
    func now() -> Double

    /// Runs `run` on the main thread after `delaySeconds`.
    func schedule(_ delaySeconds: Double, _ run: @escaping () -> Void) -> Cancellable
}

/// The app's clock: monotonic seconds that keep counting through sleep, and timers on the main
/// queue, which is where ``PlayerHost`` and ``EventSink`` live.
public final class MainQueueClock: Clock {
    private final class Timer: Cancellable {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }

    public init() {}

    public func now() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
    }

    public func schedule(_ delaySeconds: Double, _ run: @escaping () -> Void) -> Cancellable {
        let item = DispatchWorkItem(block: run)
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds, execute: item)
        return Timer(item)
    }
}
