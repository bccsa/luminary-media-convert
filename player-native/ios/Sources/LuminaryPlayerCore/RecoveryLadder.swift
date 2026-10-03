/// The recovery ladder: the obligation `PlayerAdapter` states in `player-core/src/types.ts`, ported
/// from `player-web/src/drivers/RecoveryLadder.ts` as a unit. Before playback may be declared
/// over, the engine tries its own in-place repair, then re-attaches with backoff, and only then
/// asks JavaScript for the one repair it cannot make itself: rebuilding the munged source.
///
/// | Rung | What | When (default policy) | Needs JS |
/// |---|---|---|---|
/// | 0 | the engine's in-place repair, once | at once | no |
/// | 1 | re-attach | +2 s | no |
/// | 2 | ask for a reload | +4 s | yes |
/// | 3 | ask for a reload | +8 s | yes |
/// | — | report the failure as fatal | | |
///
/// It lives beside the engine because a locked screen freezes JavaScript while AVPlayer keeps
/// playing: a ladder in the web view would be frozen exactly when it is needed. Its timers run on
/// the ``Clock``, which is monotonic, so an error that recurs the instant playback resumes is
/// seen as recurring rather than fresh. Main thread only.
public final class RecoveryLadder {
    public enum Reason: String, Sendable {
        case wedged, fatal
    }

    /// A failure the engine could not get past.
    public struct Failure: Equatable, Sendable {
        public let category: String
        public let code: String
        public let message: String

        public init(category: String, code: String, message: String) {
            self.category = category
            self.code = code
            self.message = message
        }
    }

    public struct Hooks {
        /// The engine's own in-place repair, or false when it has none. Saying yes to a repair
        /// that did nothing is worse than saying no: the ladder believes it and stops climbing.
        public let recoverInPlace: (_ category: String) -> Bool
        /// Re-prepare the engine against the source it already holds.
        public let reattach: () -> Void
        /// Ask JavaScript to rebuild the munged source.
        public let requestReload: (_ reason: Reason, _ attempt: Int) -> Void
        /// Every rung spent: playback is over.
        public let onExhausted: (_ failure: Failure) -> Void

        public init(
            recoverInPlace: @escaping (_ category: String) -> Bool,
            reattach: @escaping () -> Void,
            requestReload: @escaping (_ reason: Reason, _ attempt: Int) -> Void,
            onExhausted: @escaping (_ failure: Failure) -> Void
        ) {
            self.recoverInPlace = recoverInPlace
            self.reattach = reattach
            self.requestReload = requestReload
            self.onExhausted = onExhausted
        }
    }

    private var policy: RecoveryPolicy
    private let clock: Clock
    private let hooks: Hooks

    private var lastCategory: String?
    private var lastAt = 0.0
    private var attempts = 0
    private var triedInPlace = false
    private var timer: Cancellable?
    private var stopped = false
    /// A reload asked for and not yet answered by playback moving again.
    public private(set) var pendingReload = false

    public init(policy: RecoveryPolicy, clock: Clock, hooks: Hooks) {
        self.policy = policy
        self.clock = clock
        self.hooks = hooks
    }

    /// The policy JavaScript resolved for the source being loaded.
    public func setPolicy(_ policy: RecoveryPolicy) {
        self.policy = policy
    }

    /// A failure the engine could not get past.
    public func note(_ failure: Failure, reason: Reason = .fatal) {
        guard !stopped else { return }
        let at = clock.now()
        let recurring = lastCategory == failure.category && (at - lastAt) * 1000 <= policy.escalationWindowMs
        lastCategory = failure.category
        lastAt = at

        // The in-place card is spent once, and never on a recurrence: the same failure back
        // inside the window means the engine's own repair is what did not hold.
        if !triedInPlace && !recurring {
            triedInPlace = true
            if hooks.recoverInPlace(failure.category) { return }
        }
        climb(failure, reason: reason)
    }

    /// Playback is moving again. Everything resets, including a reload still outstanding: it
    /// either arrived and worked, or stopped mattering.
    public func notePlaybackHealthy() {
        lastCategory = nil
        lastAt = 0
        attempts = 0
        triedInPlace = false
        pendingReload = false
    }

    /// A source was loaded. Resets the ladder, unless this is the reload the ladder asked for:
    /// clearing the count then would climb the same rungs forever.
    public func noteSourceLoaded() {
        if pendingReload { return }
        notePlaybackHealthy()
    }

    public func destroy() {
        stopped = true
        timer?.cancel()
        timer = nil
        pendingReload = false
    }

    private func climb(_ failure: Failure, reason: Reason) {
        // An attempt is already scheduled; a burst of failures does not buy a rung each.
        guard timer == nil else { return }

        if attempts >= policy.maxReloadAttempts {
            // Nothing is outstanding once the ladder has given up.
            pendingReload = false
            hooks.onExhausted(failure)
            return
        }

        let attempt = attempts
        attempts += 1
        let delays = policy.reloadDelaysMs
        let delayMs = delays.isEmpty ? 0 : delays[min(attempt, delays.count - 1)]

        timer = clock.schedule(delayMs / 1000) { [weak self] in
            guard let self, !self.stopped else { return }
            self.timer = nil
            if attempt == 0 {
                // Rung 1: needs nothing from JavaScript, so a suspended app can still take it.
                self.hooks.reattach()
                return
            }
            // Rung 2 and up. Remembered before it is raised, so the source JavaScript rebuilds
            // keeps the count.
            self.pendingReload = true
            self.hooks.requestReload(reason, attempt + 1)
        }
    }
}
