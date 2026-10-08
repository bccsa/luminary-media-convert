import LuminaryPlayerCore

/// Timers due at the same instant fire in the order they were set, and `now()` reads the
/// timer's own time while it fires, so a position computed inside one is exact.
final class VirtualClock: Clock {
    private final class Timer: Cancellable {
        let at: Double
        let seq: Int
        let run: () -> Void
        weak var clock: VirtualClock?

        init(at: Double, seq: Int, run: @escaping () -> Void, clock: VirtualClock) {
            self.at = at
            self.seq = seq
            self.run = run
            self.clock = clock
        }

        func cancel() {
            clock?.timers.removeAll { $0 === self }
        }
    }

    private var current = 0.0
    private var sequence = 0
    private var timers: [Timer] = []

    func now() -> Double { current }

    func schedule(_ delaySeconds: Double, _ run: @escaping () -> Void) -> Cancellable {
        let timer = Timer(at: current + delaySeconds, seq: sequence, run: run, clock: self)
        sequence += 1
        timers.append(timer)
        return timer
    }

    func advance(_ seconds: Double) {
        let until = current + seconds
        while let next = timers
            .filter({ $0.at <= until })
            .min(by: { ($0.at, $0.seq) < ($1.at, $1.seq) }) {
            timers.removeAll { $0 === next }
            current = next.at
            next.run()
        }
        current = until
    }
}
