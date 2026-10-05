import LuminaryPlayerCore

/// Timers fire in time order when the clock is advanced.
final class ManualClock: Clock {
    private final class Timer: Cancellable {
        let at: Double
        let run: () -> Void
        var cancelled = false
        init(at: Double, run: @escaping () -> Void) {
            self.at = at
            self.run = run
        }
        func cancel() { cancelled = true }
    }

    private var current = 0.0
    private var timers: [Timer] = []

    func now() -> Double { current }

    func schedule(_ delaySeconds: Double, _ run: @escaping () -> Void) -> Cancellable {
        let timer = Timer(at: current + delaySeconds, run: run)
        timers.append(timer)
        return timer
    }

    func advance(_ seconds: Double) {
        let until = current + seconds
        while let next = timers.filter({ !$0.cancelled && $0.at <= until }).min(by: { $0.at < $1.at }) {
            timers.removeAll { $0 === next }
            current = next.at
            next.run()
        }
        current = until
    }
}
