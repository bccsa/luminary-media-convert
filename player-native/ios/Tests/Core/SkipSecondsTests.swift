import Testing
import LuminaryPlayerCore

/// Mirrors `snapSkipSeconds` in `player-web`, so a skip means the same on every platform.
@Suite("Skip seconds")
struct SkipSecondsTests {
    @Test("the seconds the skin can draw are kept")
    func kept() {
        #expect(snapSkipSeconds(5) == 5)
        #expect(snapSkipSeconds(10) == 10)
        #expect(snapSkipSeconds(30) == 30)
    }

    @Test("anything else snaps to the nearest, the first winning a tie")
    func nearest() {
        #expect(snapSkipSeconds(1) == 5)
        #expect(snapSkipSeconds(7) == 5)
        #expect(snapSkipSeconds(8) == 10)
        #expect(snapSkipSeconds(20) == 10)
        #expect(snapSkipSeconds(100) == 30)
    }

    @Test("zero, negative and non-finite mean no button")
    func none() {
        #expect(snapSkipSeconds(0) == nil)
        #expect(snapSkipSeconds(-10) == nil)
        #expect(snapSkipSeconds(.nan) == nil)
        #expect(snapSkipSeconds(.infinity) == nil)
    }

    @Test("the options snap each direction on its own")
    func eachDirection() {
        let options = SkinOptions(skipBackSeconds: 12, skipForwardSeconds: 0)
        #expect(options.back == 10)
        #expect(options.forward == nil)
    }
}
