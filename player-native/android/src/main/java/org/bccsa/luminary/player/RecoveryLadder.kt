package org.bccsa.luminary.player

/**
 * The recovery ladder: the obligation `PlayerAdapter` states in `player-core/src/types.ts`, ported
 * from `player-web/src/drivers/RecoveryLadder.ts` and the Swift port as a unit. Before playback
 * may be declared over, the engine tries its own in-place repair, then re-attaches with backoff,
 * and only then asks JavaScript for the one repair it cannot make itself: rebuilding the munged
 * source.
 *
 * | Rung | What | When (default policy) | Needs JS |
 * |---|---|---|---|
 * | 0 | the engine's in-place repair, once | at once | no |
 * | 1 | re-attach | +2 s | no |
 * | 2 | ask for a reload | +4 s | yes |
 * | 3 | ask for a reload | +8 s | yes |
 * | — | report the failure as fatal | | |
 *
 * It sits beside ExoPlayer's `LoadErrorHandlingPolicy` rather than over it: the policy retries a
 * single failed request inside the load, and the ladder only ever sees what ExoPlayer has already
 * given up on. It lives beside the engine because a locked screen freezes JavaScript while the
 * player keeps playing. Its timers run on the [Clock], which is monotonic, so an error that
 * recurs the instant playback resumes is seen as recurring. A reload asked for while the app is in
 * the background is held for `resumed()`; it goes with everything else the ladder forgets, so a
 * resume never rebuilds a source the ladder has reported as failed. Main thread only.
 */
class RecoveryLadder(
    private var policy: RecoveryPolicy,
    private val clock: Clock,
    private val hooks: Hooks,
) {
    enum class Reason(val wire: String) { WEDGED("wedged"), FATAL("fatal") }

    /**
     * A failure the engine could not get past. [needsRebuild] marks one no re-attach can fix (a
     * decoder that will not initialise, an asset that is gone): it skips straight to the reload.
     */
    data class Failure(
        val category: String,
        val code: String,
        val message: String,
        val needsRebuild: Boolean = false,
    )

    interface Hooks {
        /**
         * The engine's own in-place repair, or false when it has none. Saying yes to a repair that
         * did nothing is worse than saying no: the ladder believes it and stops climbing.
         */
        fun recoverInPlace(category: String): Boolean

        /** Re-prepare the engine against the source it already holds. */
        fun reattach()

        /** Ask JavaScript to rebuild the munged source. */
        fun requestReload(reason: Reason, attempt: Int)

        /** Every rung spent: playback is over. */
        fun onExhausted(failure: Failure)
    }

    private var lastCategory: String? = null
    private var lastAt = 0.0
    private var attempts = 0
    private var triedInPlace = false
    private var timer: Cancellable? = null
    private var stopped = false

    /** Every rung spent and the failure reported: the next failure that counts follows playback moving again. */
    private var exhausted = false
    private var suspended = false
    private var held: PendingReload? = null

    /** A reload asked for and not yet answered by playback moving again. */
    var pendingReload = false
        private set

    /** The policy JavaScript resolved for the source being loaded. */
    fun setPolicy(policy: RecoveryPolicy) {
        this.policy = policy
    }

    /** A failure the engine could not get past. */
    fun note(failure: Failure, reason: Reason = Reason.FATAL) {
        if (stopped || exhausted) return
        val at = clock.now()
        val recurring = lastCategory == failure.category && (at - lastAt) * 1000 <= policy.escalationWindowMs
        lastCategory = failure.category
        lastAt = at

        // The in-place card is spent once, and never on a recurrence: the same failure back
        // inside the window means the engine's own repair is what did not hold.
        if (!triedInPlace && !recurring && !failure.needsRebuild) {
            triedInPlace = true
            if (hooks.recoverInPlace(failure.category)) return
        }
        climb(failure, reason)
    }

    /**
     * Playback is moving again. Everything resets, including a reload still outstanding and a rung
     * still scheduled: either would rebuild a player that has recovered.
     */
    fun notePlaybackHealthy() {
        lastCategory = null
        lastAt = 0.0
        attempts = 0
        triedInPlace = false
        exhausted = false
        pendingReload = false
        held = null
        timer?.cancel()
        timer = null
    }

    /**
     * A source was loaded. Resets the ladder, unless this is the reload the ladder asked for:
     * clearing the count then would climb the same rungs forever.
     */
    fun noteSourceLoaded() {
        if (pendingReload) return
        notePlaybackHealthy()
    }

    /** The app went to the background (true) or came back (false). */
    fun setAppSuspended(suspended: Boolean) {
        this.suspended = suspended
    }

    /** The reload held while the app was in the background, handed over once. */
    fun takeHeldReload(): PendingReload? = held.also { held = null }

    fun destroy() {
        stopped = true
        timer?.cancel()
        timer = null
        pendingReload = false
        held = null
    }

    private fun climb(failure: Failure, reason: Reason) {
        // An attempt is already scheduled; a burst of failures does not buy a rung each.
        if (timer != null) return

        if (attempts >= policy.maxReloadAttempts) {
            // Nothing is outstanding once the ladder has given up, and it is reported once.
            exhausted = true
            pendingReload = false
            held = null
            hooks.onExhausted(failure)
            return
        }

        // Rung 1 is a re-attach, which cannot fix a failure that needs the source rebuilt.
        val attempt = if (failure.needsRebuild) maxOf(attempts, 1) else attempts
        attempts = attempt + 1
        val delays = policy.reloadDelaysMs
        val delayMs = if (delays.isEmpty()) 0.0 else delays[minOf(attempt, delays.size - 1)]

        timer = clock.schedule(delayMs / 1000) {
            if (stopped) return@schedule
            timer = null
            if (attempt == 0) {
                // Rung 1: needs nothing from JavaScript, so a suspended app can still take it.
                hooks.reattach()
                return@schedule
            }
            // Rung 2 and up. Remembered before it is raised, so the source JavaScript rebuilds
            // keeps the count. Raised at once while JavaScript can act on it; held while the app
            // is in the background.
            pendingReload = true
            if (suspended) {
                held = PendingReload(reason.wire, attempt + 1)
            } else {
                hooks.requestReload(reason, attempt + 1)
            }
        }
    }
}
