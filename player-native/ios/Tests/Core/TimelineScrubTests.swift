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

    @Test("a tap opens the strip without moving the video or holding it")
    func tapOpens() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: true)
        #expect(scrub.mode == .strip)
        #expect(box.effects == [.open(.strip)])
    }

    @Test("without frames a tap opens the thick bar instead")
    func tapWithoutFrames() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: false)
        #expect(scrub.mode == .bar)
        #expect(box.effects == [.open(.bar)])
    }

    @Test("a drag holds the video under the finger, and it plays on from where the finger let go")
    func dragHoldsThenPlays() {
        let (scrub, _, box) = make()
        scrub.dragBegan(framesReady: true, playing: true)
        #expect(box.effects == [.open(.strip), .pause])
        scrub.dragEnded(at: 42)
        #expect(scrub.isOpen)
        #expect(box.effects == [.open(.strip), .pause, .seek(42), .play])
    }

    @Test("a video that was paused stays paused after a drag")
    func pausedStaysPaused() {
        let (scrub, _, box) = make()
        scrub.dragBegan(framesReady: true, playing: false)
        scrub.dragEnded(at: 10)
        #expect(box.effects == [.open(.strip), .seek(10)])
    }

    @Test("a drag taken away from the finger plays on without moving")
    func cancelledDragPlaysOn() {
        let (scrub, _, box) = make()
        scrub.dragBegan(framesReady: true, playing: true)
        scrub.dragCancelled()
        #expect(box.effects == [.open(.strip), .pause, .play])
    }

    @Test("a drag reported again while under way holds and plays on once")
    func dragReportedTwice() {
        let (scrub, _, box) = make()
        scrub.dragBegan(framesReady: true, playing: true)
        scrub.dragBegan(framesReady: true, playing: false)
        scrub.dragEnded(at: 5)
        #expect(box.effects == [.open(.strip), .pause, .seek(5), .play])
    }

    @Test("it closes five seconds after the last touch, leaving playback alone")
    func closesAfterIdle() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true)
        clock.advance(4.9)
        #expect(scrub.isOpen)
        clock.advance(0.1)
        #expect(!scrub.isOpen)
        #expect(box.effects == [.open(.strip), .close])
    }

    @Test("a finger on it keeps it open, and the count starts again when it lifts")
    func fingerKeepsOpen() {
        let (scrub, clock, _) = make()
        scrub.tapped(framesReady: true)
        clock.advance(2)
        scrub.dragBegan(framesReady: true, playing: true)
        clock.advance(10)
        #expect(scrub.isOpen)
        scrub.dragEnded(at: 5)
        clock.advance(4.9)
        #expect(scrub.isOpen)
        clock.advance(0.1)
        #expect(!scrub.isOpen)
    }

    @Test("a tap elsewhere closes it")
    func tapElsewhereCloses() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: true)
        scrub.tappedElsewhere()
        #expect(!scrub.isOpen)
        #expect(box.effects == [.open(.strip), .close])
    }

    @Test("play closes it and plays")
    func playCloses() {
        let (scrub, _, box) = make()
        scrub.tapped(framesReady: false)
        scrub.playPressed()
        #expect(!scrub.isOpen)
        #expect(box.effects == [.open(.bar), .close, .play])
    }

    @Test("a new video mid-drag puts it away without playing")
    func resetMidDrag() {
        let (scrub, clock, box) = make()
        scrub.dragBegan(framesReady: true, playing: true)
        scrub.reset()
        clock.advance(10)
        #expect(box.effects == [.open(.strip), .pause, .close])
    }

    @Test("a second tap while open does nothing but start the count again")
    func secondTap() {
        let (scrub, clock, box) = make()
        scrub.tapped(framesReady: true)
        clock.advance(2)
        scrub.tapped(framesReady: true)
        clock.advance(4.9)
        #expect(scrub.isOpen)
        #expect(box.effects == [.open(.strip)])
    }
}
