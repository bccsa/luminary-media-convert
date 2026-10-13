import AVFoundation
import Testing
import LuminaryPlayerCore

/// Captures what the engine presents, so a test can drive the full-screen commands.
private final class RecordingPresenter: FullscreenPresenter {
    var commands: FullscreenCommands?
    var presented = false

    func present(
        _ player: AVPlayer,
        commands: FullscreenCommands,
        texts: FullscreenTexts,
        onLeave: @escaping () -> Void,
        onPresentation: @escaping (Presentation) -> Void
    ) -> Bool {
        guard !presented else { return false }
        presented = true
        self.commands = commands
        return true
    }

    func startPictureInPicture() -> Bool { false }
    func showRoutePicker() -> Bool { false }

    func dismiss() -> Bool {
        defer { presented = false }
        return presented
    }
}

/// The engine on a real AVPlayer, with the item's notifications posted by hand: what AVFoundation
/// would report is what the engine then says.
@Suite("AVPlayerEngine")
@MainActor
struct AVPlayerEngineTests {
    private func make() -> (AVPlayerEngine, RecordingPresenter) {
        let presenter = RecordingPresenter()
        let engine = AVPlayerEngine(
            router: UriRouter(assets: AssetStore(), key: KeyHolder()),
            clock: ManualClock(),
            options: CreateOptions(protocolVersion: 1, skipBackSeconds: 10, skipForwardSeconds: 10),
            presenter: presenter
        )
        engine.load(masterUri: "luminary://asset/0/master.m3u8", startPosition: nil, nowPlaying: nil, recovery: .default)
        return (engine, presenter)
    }

    @Test("a sleep timer is kept on the clock until its time, replaced by a new one, and cleared by none")
    func sleepTimer() {
        let clock = ManualClock()
        let engine = AVPlayerEngine(
            router: UriRouter(assets: AssetStore(), key: KeyHolder()),
            clock: clock,
            options: CreateOptions(protocolVersion: 1, skipBackSeconds: 10, skipForwardSeconds: 10),
            presenter: RecordingPresenter()
        )
        let now = Date().timeIntervalSince1970 * 1000

        engine.setSleepTimer(endsAt: now + 90_000)
        #expect(clock.pending == 1)
        #expect(abs(clock.delays.last! - 90) < 2)

        engine.setSleepTimer(endsAt: now + 600_000)
        #expect(clock.pending == 1)
        #expect(abs(clock.delays.last! - 600) < 2)

        engine.setSleepTimer(endsAt: nil)
        #expect(clock.pending == 0)

        // A time already past fires at once; the engine has nothing playing, so it stays quiet, and the timer is spent.
        engine.setSleepTimer(endsAt: now - 5_000)
        #expect(clock.delays.last! == 0)
        clock.advance(1)
        #expect(clock.pending == 0)

        engine.setSleepTimer(endsAt: now + 60_000)
        engine.destroy()
        #expect(clock.pending == 0)
    }

    @Test("a media services reset gives the engine a new player that carries on as the old one was")
    func mediaServicesReset() throws {
        let (engine, presenter) = make()
        engine.play()
        engine.setMuted(true)
        engine.enterFullscreen(texts: nil)
        #expect(presenter.presented)
        let old = engine.player

        engine.recreatePlayerAfterMediaServicesReset()

        // A new player, muted as the viewer had it, with the item built again; full-screen held
        // the dead player's picture, so it is gone.
        #expect(engine.player !== old)
        #expect(engine.player.isMuted)
        #expect(engine.player.currentItem != nil)
        #expect(!presenter.presented)
        // The intent to play survived: full-screen opened now offers pause, not play.
        engine.enterFullscreen(texts: nil)
        let commands = try #require(presenter.commands)
        #expect(commands.playbackWanted())
    }

    @Test("a reset after the engine was destroyed does nothing")
    func mediaServicesResetAfterDestroy() {
        let (engine, _) = make()
        engine.destroy()
        let old = engine.player
        engine.recreatePlayerAfterMediaServicesReset()
        #expect(engine.player === old)
    }

    @Test("the end of the item ends the viewer's intent to play, so full-screen offers play")
    func endedIsNotPlaying() throws {
        let (engine, presenter) = make()
        engine.play()
        engine.enterFullscreen(texts: nil)
        let commands = try #require(presenter.commands)
        #expect(commands.playbackWanted())

        NotificationCenter.default.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: engine.player.currentItem)
        #expect(!commands.playbackWanted())

        // Play again starts over, and is wanted again.
        commands.play()
        #expect(commands.playbackWanted())
        engine.destroy()
    }

    @Test("a pause by the viewer is not wanted playback; a failure keeps it")
    func pauseAndFailure() throws {
        let (engine, presenter) = make()
        engine.play()
        engine.enterFullscreen(texts: nil)
        let commands = try #require(presenter.commands)

        commands.pause()
        #expect(!commands.playbackWanted())
        commands.play()
        NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: engine.player.currentItem)
        #expect(commands.playbackWanted())
        engine.destroy()
    }
}
