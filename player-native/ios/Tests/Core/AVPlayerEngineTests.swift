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
