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
        onLeave: @escaping () -> Void,
        onPresentation: @escaping (Presentation) -> Void
    ) -> Bool {
        guard !presented else { return false }
        presented = true
        self.commands = commands
        return true
    }

    func startPictureInPicture() -> Bool { false }

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

    @Test("the end of the item ends the viewer's intent to play, so full-screen offers play")
    func endedIsNotPlaying() throws {
        let (engine, presenter) = make()
        engine.play()
        engine.enterFullscreen()
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
        engine.enterFullscreen()
        let commands = try #require(presenter.commands)

        commands.pause()
        #expect(!commands.playbackWanted())
        commands.play()
        NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: engine.player.currentItem)
        #expect(commands.playbackWanted())
        engine.destroy()
    }
}
