import Testing
import LuminaryPlayerCore

@Suite("Full-screen controls: which show")
struct FullscreenControlsLayoutTests {
    private func layout(_ change: (inout FullscreenControlsState) -> Void = { _ in }, skin: SkinOptions = .init())
        -> FullscreenControlsLayout {
        var state = FullscreenControlsState()
        change(&state)
        return FullscreenControlsLayout(state, skin: skin)
    }

    @Test("skips by the skin's seconds, snapped as the web snaps them, and none at zero")
    func skips() {
        #expect(layout().skipBack == 10)
        #expect(layout().skipForward == 10)
        let custom = layout(skin: SkinOptions(skipBackSeconds: 4, skipForwardSeconds: 0))
        #expect(custom.skipBack == 5)
        #expect(custom.skipForward == nil)
    }

    @Test("live hides the skips, the speed and the progress bar")
    func live() {
        let live = layout { $0.live = true }
        #expect(live.skipBack == nil)
        #expect(live.skipForward == nil)
        #expect(!live.showsRate)
        #expect(!live.showsProgress)
        #expect(layout().showsRate)
        #expect(layout().showsProgress)
    }

    @Test("until the item says what it is, no skip, speed or progress is shown")
    func awaitingDuration() {
        let waiting = layout { $0.awaitingDuration = true }
        #expect(waiting.skipBack == nil)
        #expect(waiting.skipForward == nil)
        #expect(!waiting.showsRate)
        #expect(!waiting.showsProgress)
        // Play and pause are not about seeking: they show from the start.
        #expect(waiting.showsPause == false)
        let playing = layout { $0.awaitingDuration = true; $0.playing = true }
        #expect(playing.showsPause)
        // Once it is known, a recorded video has them all.
        let known = layout { $0.duration = 120 }
        #expect(known.skipBack == 10)
        #expect(known.showsRate)
        #expect(known.showsProgress)
    }

    @Test("shows the audio menu only with more than one track, as video.js does")
    func audioMenu() {
        #expect(!layout { $0.audioTrackCount = 1 }.showsAudioMenu)
        #expect(layout { $0.audioTrackCount = 2 }.showsAudioMenu)
    }

    @Test("shows the subtitles menu only when there are subtitles")
    func subtitlesMenu() {
        #expect(!layout().showsSubtitlesMenu)
        #expect(layout { $0.hasSubtitles = true }.showsSubtitlesMenu)
    }

    @Test("the spinner takes play/pause's place only while waiting for wanted playback")
    func spinner() {
        #expect(layout { $0.playing = true; $0.waiting = true }.showsSpinner)
        #expect(!layout { $0.playing = false; $0.waiting = true }.showsSpinner)
        #expect(!layout { $0.playing = true }.showsSpinner)
    }

    @Test("pause while playing, play otherwise")
    func playPause() {
        #expect(layout { $0.playing = true }.showsPause)
        #expect(!layout().showsPause)
    }
}

@Suite("Full-screen controls: time and speed text")
struct FullscreenControlsTextTests {
    @Test("formats time as video.js does")
    func formatsTime() {
        #expect(formatTime(7, guide: 120) == "0:07")
        #expect(formatTime(120, guide: 120) == "2:00")
        #expect(formatTime(65, guide: 900) == "01:05")
        #expect(formatTime(3723, guide: 3723) == "1:02:03")
        #expect(formatTime(5, guide: 3723) == "0:00:05")
        #expect(formatTime(-3, guide: 120) == "0:00")
        #expect(formatTime(.nan, guide: 120) == "-:-")
        #expect(formatTime(.nan, guide: 4000) == "-:-:-")
    }

    @Test("reads position over duration, and LIVE on live")
    func timeRow() {
        var state = FullscreenControlsState()
        state.position = 7.4
        state.duration = 120
        #expect(timeText(state) == "0:07 / 2:00")
        state.live = true
        #expect(timeText(state) == "LIVE")
    }

    @Test("labels speeds as video.js does")
    func rates() {
        #expect(fullscreenRates.map(rateLabel) == ["0.5x", "0.7x", "1x", "1.5x"])
    }

    @Test("a speed read back from the player's float is the speed that was set")
    func roundTripsFloat() {
        #expect(roundedRate(Double(Float(0.7))) == 0.7)
        #expect(fullscreenRates.allSatisfy { roundedRate(Double(Float($0))) == $0 })
    }
}

@Suite("Full-screen controls: auto-hide")
struct FullscreenControlsVisibilityTests {
    private func make() -> (FullscreenControlsVisibility, ManualClock, Box) {
        let clock = ManualClock()
        let visibility = FullscreenControlsVisibility(clock: clock)
        let changes = Box()
        visibility.onChange = { changes.values.append($0) }
        return (visibility, clock, changes)
    }

    final class Box { var values: [Bool] = [] }

    @Test("hide 3 s after playback starts")
    func hidesWhilePlaying() {
        let (visibility, clock, changes) = make()
        visibility.playbackChanged(playing: true)
        clock.advance(2.9)
        #expect(visibility.visible)
        clock.advance(0.1)
        #expect(!visibility.visible)
        #expect(changes.values == [false])
    }

    @Test("stay while paused, and come back on pause")
    func staysWhilePaused() {
        let (visibility, clock, _) = make()
        clock.advance(10)
        #expect(visibility.visible)
        visibility.playbackChanged(playing: true)
        clock.advance(3)
        visibility.playbackChanged(playing: false)
        #expect(visibility.visible)
        clock.advance(10)
        #expect(visibility.visible)
    }

    @Test("a touch on a control starts the 3 s again")
    func touchRestarts() {
        let (visibility, clock, _) = make()
        visibility.playbackChanged(playing: true)
        clock.advance(2)
        visibility.touched()
        clock.advance(2)
        #expect(visibility.visible)
        clock.advance(1)
        #expect(!visibility.visible)
    }

    @Test("a tap on the picture hides shown controls while playing, and shows hidden ones")
    func tapPicture() {
        let (visibility, clock, _) = make()
        visibility.playbackChanged(playing: true)
        visibility.tappedPicture()
        #expect(!visibility.visible)
        visibility.tappedPicture()
        #expect(visibility.visible)
        clock.advance(3)
        #expect(!visibility.visible)
    }

    @Test("a tap on the picture while paused keeps them")
    func tapWhilePaused() {
        let (visibility, _, _) = make()
        visibility.tappedPicture()
        #expect(visibility.visible)
    }

    @Test("an open menu holds them until touched again")
    func menuHolds() {
        let (visibility, clock, _) = make()
        visibility.playbackChanged(playing: true)
        visibility.hold()
        clock.advance(30)
        #expect(visibility.visible)
        visibility.touched()
        clock.advance(3)
        #expect(!visibility.visible)
    }
}

@Suite("Full-screen texts")
struct FullscreenTextsTests {
    @Test("the host's strings override the English ones; the rest stay English")
    func overriding() {
        let texts = FullscreenTexts(overriding: ["exitFullscreen": "Quitter le plein écran", "skipBack": "Reculer de {seconds} secondes"])
        #expect(texts.exitFullscreen == "Quitter le plein écran")
        #expect(texts.skipBack(10) == "Reculer de 10 secondes")
        #expect(texts.playbackRate == "Playback Rate")
        #expect(texts.skipForward(10) == "Skip forward 10 seconds")
    }

    @Test("an empty string, or a key native does not know, changes nothing")
    func ignoresWhatItCannotUse() {
        let texts = FullscreenTexts(overriding: ["mute": "", "volume": "Volume"])
        #expect(texts == FullscreenTexts())
    }
}
