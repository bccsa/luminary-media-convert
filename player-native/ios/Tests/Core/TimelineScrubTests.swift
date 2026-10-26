import Testing
@testable import LuminaryPlayerCore

@Suite("Timeline: two touches to scrub")
struct TimelineScrubTests {
    final class Box { var effects: [TimelineScrub.Effect] = [] }

    private func make() -> (TimelineScrub, ManualClock, Box) {
        let clock = ManualClock()
        let scrub = TimelineScrub(clock: clock)
        let box = Box()
        scrub.onEffect = { box.effects.append($0) }
        return (scrub, clock, box)
    }

    @Test("a tap opens the strip and holds the video, without moving it")
    func tapOpens() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        #expect(scrub.mode == .strip)
        #expect(box.effects == [.open(.strip), .pause])
    }

    @Test("without frames a tap opens the thick bar instead")
    func tapWithoutFrames() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: false, playing: true)
        #expect(scrub.mode == .bar)
        #expect(box.effects == [.open(.bar), .pause])
    }

    @Test("only a drag moves the video, and it stays held after")
    func dragSeeks() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        scrub.dragBegan(framesReady: true, playing: false)
        scrub.dragEnded(at: 42)
        #expect(box.effects == [.open(.strip), .pause, .seek(42)])
        #expect(scrub.isOpen)
    }

    @Test("a drag from closed opens it on the way")
    func dragFromClosed() {
        let (scrub, _, box) = make()
        scrub.dragBegan(framesReady: true, playing: true)
        scrub.dragEnded(at: 10)
        #expect(box.effects == [.open(.strip), .pause, .seek(10)])
    }

    @Test("it closes three seconds after the last touch, and the video plays on")
    func idleCloses() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        clock.advance(2.9)
        #expect(scrub.isOpen)
        clock.advance(0.1)
        #expect(!scrub.isOpen)
        #expect(box.effects.suffix(2) == [.close, .play])
    }

    @Test("a finger on it keeps it open, and the count starts again when it lifts")
    func touchHolds() {
        let (scrub, clock, _) = make()
        scrub.tapped(framesReady: true, playing: true)
        clock.advance(2)
        scrub.dragBegan(framesReady: true, playing: false)
        clock.advance(10)
        #expect(scrub.isOpen)
        scrub.dragEnded(at: 5)
        clock.advance(2.9)
        #expect(scrub.isOpen)
        clock.advance(0.1)
        #expect(!scrub.isOpen)
    }

    @Test("a tap elsewhere closes it and the video plays on")
    func elsewhereCloses() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        scrub.tappedElsewhere()
        #expect(!scrub.isOpen)
        #expect(box.effects == [.open(.strip), .pause, .close, .play])
    }

    @Test("a video that was paused stays paused when it closes")
    func pausedStaysPaused() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true, playing: false)
        clock.advance(3)
        #expect(box.effects == [.open(.strip), .close])
    }

    @Test("play closes it and plays, even if the video was paused")
    func playCloses() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: false, playing: false)
        scrub.playPressed()
        #expect(!scrub.isOpen)
        #expect(box.effects == [.open(.bar), .close, .play])
    }

    @Test("a new video puts it away without playing")
    func resetDoesNotPlay() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        scrub.reset()
        #expect(box.effects == [.open(.strip), .pause, .close])
        #expect(clock.pending == 0)
    }

    @Test("a second tap while open does nothing but start the count again")
    func secondTap() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true, playing: true)
        clock.advance(2)
        scrub.tapped(framesReady: true, playing: false)
        clock.advance(2.9)
        #expect(scrub.isOpen)
        #expect(box.effects == [.open(.strip), .pause])
    }
}
