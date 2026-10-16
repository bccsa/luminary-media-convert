import Testing
import LuminaryPlayerCore

/// The ladder's hooks, recording what it did and when.
private final class Recorder {
    var steps: [String] = []
    var inPlaceAnswer = false
    let clock = ManualClock()

    func hooks() -> RecoveryLadder.Hooks {
        RecoveryLadder.Hooks(
            recoverInPlace: { [unowned self] _ in steps.append("in-place"); return inPlaceAnswer },
            reattach: { [unowned self] in steps.append("reattach@\(clock.now())") },
            requestReload: { [unowned self] reason, attempt in steps.append("reload(\(reason.rawValue),\(attempt))@\(clock.now())") },
            onExhausted: { [unowned self] failure in steps.append("exhausted:\(failure.code)") }
        )
    }
}

private let failure = RecoveryLadder.Failure(category: "network", code: "network-error", message: "offline")

@Suite("Recovery ladder")
struct RecoveryLadderTests {
    private func ladder(_ recorder: Recorder, policy: RecoveryPolicy = .default) -> RecoveryLadder {
        RecoveryLadder(policy: policy, clock: recorder.clock, hooks: recorder.hooks())
    }

    @Test("climbs in-place, re-attach, two reloads, then reports the failure")
    func fullClimb() {
        let recorder = Recorder()
        let ladder = ladder(recorder)

        ladder.note(failure)
        recorder.clock.advance(2)
        ladder.note(failure)
        recorder.clock.advance(4)
        ladder.note(failure)
        recorder.clock.advance(8)
        ladder.note(failure)

        #expect(recorder.steps == [
            "in-place",
            "reattach@2.0",
            "reload(fatal,2)@6.0",
            "reload(fatal,3)@14.0",
            "exhausted:network-error",
        ])
    }

    @Test("an in-place repair that took stops the climb")
    func inPlaceRepair() {
        let recorder = Recorder()
        recorder.inPlaceAnswer = true
        let ladder = ladder(recorder)

        ladder.note(failure)
        recorder.clock.advance(30)

        #expect(recorder.steps == ["in-place"])
    }

    @Test("the in-place repair is not offered again for the same failure inside the window")
    func noInPlaceOnRecurrence() {
        let recorder = Recorder()
        recorder.inPlaceAnswer = true
        let ladder = ladder(recorder)

        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        recorder.clock.advance(2)

        #expect(recorder.steps == ["in-place", "reattach@3.0"])
    }

    @Test("a burst of failures while a rung is scheduled buys no extra rungs")
    func burst() {
        let recorder = Recorder()
        let ladder = ladder(recorder)

        ladder.note(failure)
        ladder.note(failure)
        ladder.note(failure)
        recorder.clock.advance(30)

        #expect(recorder.steps == ["in-place", "reattach@2.0"])
    }

    @Test("playback moving again starts the ladder over")
    func healthyResets() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)
        recorder.clock.advance(2)

        ladder.notePlaybackHealthy()
        ladder.note(failure)
        recorder.clock.advance(2)

        #expect(recorder.steps == ["in-place", "reattach@2.0", "in-place", "reattach@4.0"])
    }

    @Test("the source a reload rebuilt keeps the count; any other source starts over")
    func sourceLoaded() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)
        recorder.clock.advance(2)
        ladder.note(failure)
        recorder.clock.advance(4)
        #expect(ladder.pendingReload)

        // The reload arrives as a new load: the count stands, so the next failure climbs on.
        ladder.noteSourceLoaded()
        ladder.note(failure)
        recorder.clock.advance(8)
        #expect(recorder.steps.last == "reload(fatal,3)@14.0")

        // A source the viewer chose is a fresh start.
        ladder.notePlaybackHealthy()
        ladder.noteSourceLoaded()
        ladder.note(failure)
        #expect(recorder.steps.last == "in-place")
    }

    @Test("nothing is outstanding once the failure is reported")
    func exhaustedClearsPending() {
        let recorder = Recorder()
        let ladder = ladder(recorder, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 2, reloadDelaysMs: [1_000]))
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        recorder.clock.advance(1)
        #expect(ladder.pendingReload)

        ladder.note(failure)

        #expect(recorder.steps.last == "exhausted:network-error")
        #expect(!ladder.pendingReload)
    }

    @Test("a rung scheduled before playback recovered does not fire")
    func healthyCancelsRung() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)
        recorder.clock.advance(1)

        ladder.notePlaybackHealthy()
        recorder.clock.advance(10)

        #expect(recorder.steps == ["in-place"])
    }

    @Test("a rung scheduled before another source loaded does not fire")
    func sourceLoadedCancelsRung() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)
        recorder.clock.advance(1)

        ladder.noteSourceLoaded()
        recorder.clock.advance(10)

        #expect(recorder.steps == ["in-place"])
    }

    @Test("reports the failure once; the next failure that counts is after playback moved again")
    func exhaustedOnce() {
        let recorder = Recorder()
        let ladder = ladder(recorder, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 1, reloadDelaysMs: [1_000]))
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        ladder.note(failure)
        ladder.note(failure)
        #expect(recorder.steps == ["in-place", "reattach@1.0", "exhausted:network-error"])

        ladder.notePlaybackHealthy()
        ladder.note(failure)
        #expect(recorder.steps.last == "in-place")
    }

    @Test("a reload asked for while the app is suspended is held for the resume, once")
    func heldWhileSuspended() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)
        recorder.clock.advance(2)
        ladder.setAppSuspended(true)
        ladder.note(failure)
        recorder.clock.advance(4)

        #expect(recorder.steps == ["in-place", "reattach@2.0"])
        #expect(ladder.pendingReload)
        #expect(ladder.takeHeldReload() == PendingReload(reason: "fatal", attempt: 2))
        #expect(ladder.takeHeldReload() == nil)
    }

    @Test("a held reload is dropped once the failure is reported, and once playback moves again")
    func heldDropped() {
        let recorder = Recorder()
        let policy = RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 2, reloadDelaysMs: [1_000])
        let ladder = ladder(recorder, policy: policy)
        ladder.setAppSuspended(true)
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        #expect(recorder.steps.last == "exhausted:network-error")
        #expect(ladder.takeHeldReload() == nil)

        let again = self.ladder(recorder, policy: policy)
        again.setAppSuspended(true)
        again.note(failure)
        recorder.clock.advance(1)
        again.note(failure)
        recorder.clock.advance(1)
        again.notePlaybackHealthy()
        #expect(again.takeHeldReload() == nil)
    }

    @Test("a policy handed over mid-climb keeps the rung already scheduled and governs the next")
    func policyChangedMidClimb() {
        let recorder = Recorder()
        let ladder = ladder(recorder)

        ladder.note(failure)
        // One attempt is allowed from here on, and the rung scheduled under the old delays stays.
        ladder.setPolicy(RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 1, reloadDelaysMs: [10_000]))
        recorder.clock.advance(2)
        ladder.note(failure)

        #expect(recorder.steps == ["in-place", "reattach@2.0", "exhausted:network-error"])
    }

    @Test("fewer delays than attempts: the last delay repeats")
    func shortDelayList() {
        let recorder = Recorder()
        let ladder = ladder(recorder, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 3, reloadDelaysMs: [1_000]))

        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)
        recorder.clock.advance(1)
        ladder.note(failure)

        #expect(recorder.steps == [
            "in-place",
            "reattach@1.0",
            "reload(fatal,2)@2.0",
            "reload(fatal,3)@3.0",
            "exhausted:network-error",
        ])
    }

    @Test("no delays at all: every rung is taken as soon as the clock moves")
    func noDelays() {
        let recorder = Recorder()
        let ladder = ladder(recorder, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 2, reloadDelaysMs: []))

        ladder.note(failure)
        recorder.clock.advance(0)
        ladder.note(failure)
        recorder.clock.advance(0)

        #expect(recorder.steps == ["in-place", "reattach@0.0", "reload(fatal,2)@0.0"])
    }

    @Test("no attempts allowed: the failure is reported at once, after the in-place repair had its turn")
    func noAttempts() {
        let recorder = Recorder()
        let ladder = ladder(recorder, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 0, reloadDelaysMs: [1_000]))

        ladder.note(failure)
        recorder.clock.advance(30)

        #expect(recorder.steps == ["in-place", "exhausted:network-error"])
        #expect(!ladder.pendingReload)

        // And a repair that took still ends it there.
        let repaired = Recorder()
        repaired.inPlaceAnswer = true
        let other = self.ladder(repaired, policy: RecoveryPolicy(escalationWindowMs: 10_000, maxReloadAttempts: 0, reloadDelaysMs: []))
        other.note(failure)
        #expect(repaired.steps == ["in-place"])
    }

    @Test("a destroyed ladder does nothing more")
    func destroyed() {
        let recorder = Recorder()
        let ladder = ladder(recorder)
        ladder.note(failure)

        ladder.destroy()
        recorder.clock.advance(30)
        ladder.note(failure)

        #expect(recorder.steps == ["in-place"])
    }
}
