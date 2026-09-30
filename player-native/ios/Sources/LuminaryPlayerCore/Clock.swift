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
