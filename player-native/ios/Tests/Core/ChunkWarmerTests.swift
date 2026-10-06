import Foundation
import Testing
@testable import LuminaryPlayerCore

// Ported from `player-web/__tests__/chunkWarming.test.ts`, case for case.

private let base = "https://cdn.example.com/out/session"

/// One chain of three chunk objects, 20 s of media each.
private let chain = [
    ChunkBoundary(url: "\(base)/media/v0_0.m4s", start: 0, end: 20),
    ChunkBoundary(url: "\(base)/media/v0_1.m4s", start: 20, end: 40),
    ChunkBoundary(url: "\(base)/media/v0_2.m4s", start: 40, end: 60),
]

private final class Harness {
    let clock = ManualClock()
    var watermark = 0.0
    var samples = 0
    var warmed: [String] = []
    var bytes: [Int] = []
    lazy var warmer = ChunkWarmer(
        clock: clock,
        watermark: { [unowned self] in
            self.samples += 1
            return self.watermark
        },
        fetch: { [unowned self] url, bytes in
            self.warmed.append(url.absoluteString)
            self.bytes.append(bytes)
        }
    )

    init(_ schedules: [[ChunkBoundary]], leadSeconds: Double = 10) {
        warmer.start(schedules, leadSeconds: leadSeconds, warmBytes: 1024)
    }
}

@Suite("ChunkWarmer, the warming loop")
struct ChunkWarmerTests {
    @Test("warms each next chunk once as the buffer approaches it")
    func warmsOnApproach() {
        let run = Harness([chain])
        run.watermark = 12
        run.clock.advance(3)
        #expect(run.warmed == ["\(base)/media/v0_1.m4s"])

        run.watermark = 32
        run.clock.advance(3)
        #expect(run.warmed == ["\(base)/media/v0_1.m4s", "\(base)/media/v0_2.m4s"])
    }

    @Test("asks for the first warmBytes, as a range")
    func asksForBytes() {
        let run = Harness([chain])
        run.watermark = 12
        run.clock.advance(1)
        #expect(run.bytes == [1024])
    }

    @Test("waits until the buffer front is within the lead")
    func waitsForLead() {
        let run = Harness([chain])
        run.watermark = 9
        run.clock.advance(5)
        #expect(run.warmed.isEmpty)
    }

    @Test("keeps sampling while any chunk is still to be warmed")
    func keepsSampling() {
        // Paused just short of the first boundary, the next chunk has to be warmed before play.
        let run = Harness([chain])
        run.watermark = 12
        run.clock.advance(1)
        let afterFirstWarm = run.samples
        run.clock.advance(5)
        #expect(run.samples == afterFirstWarm + 5)
    }

    @Test("stops sampling once every chunk has been warmed")
    func stopsWhenDone() {
        let run = Harness([chain])
        run.watermark = 12
        run.clock.advance(1)
        run.watermark = 32
        run.clock.advance(1)
        let atLastWarm = run.samples
        run.clock.advance(60)
        #expect(run.samples == atLastWarm)
        #expect(!run.warmer.ticking)
    }

    @Test("waits for every chain, not only the first to finish")
    func everyChain() {
        let audio = [
            ChunkBoundary(url: "\(base)/media/a_0.m4s", start: 0, end: 50),
            ChunkBoundary(url: "\(base)/media/a_1.m4s", start: 50, end: 100),
        ]
        let run = Harness([chain, audio])
        run.watermark = 12
        run.clock.advance(1)
        run.watermark = 32
        run.clock.advance(1)
        #expect(run.warmed == ["\(base)/media/v0_1.m4s", "\(base)/media/v0_2.m4s"])

        let before = run.samples
        run.clock.advance(3)
        #expect(run.samples == before + 3)

        run.watermark = 45
        run.clock.advance(1)
        #expect(run.warmed.contains("\(base)/media/a_1.m4s"))
        let done = run.samples
        run.clock.advance(10)
        #expect(run.samples == done)
    }

    @Test("keeps sampling while a chunk skipped by a seek is still unwarmed")
    func skippedBySeek() {
        // A seek back can still make that boundary the next one.
        let run = Harness([chain])
        run.watermark = 32
        run.clock.advance(1)
        #expect(run.warmed == ["\(base)/media/v0_2.m4s"])

        let before = run.samples
        run.clock.advance(3)
        #expect(run.samples == before + 3)

        run.watermark = 12
        run.clock.advance(1)
        #expect(run.warmed == ["\(base)/media/v0_2.m4s", "\(base)/media/v0_1.m4s"])
        let done = run.samples
        run.clock.advance(10)
        #expect(run.samples == done)
    }

    @Test("never starts sampling when there is nothing to warm")
    func nothingToWarm() {
        // A chain of one chunk: the engine's own start-up request fetches it.
        let run = Harness([[ChunkBoundary(url: "\(base)/media/v0_0.m4s", start: 0, end: 60)]])
        run.clock.advance(10)
        #expect(run.samples == 0)
        #expect(!run.warmer.ticking)
    }

    @Test("does not start again for chunks it has already warmed")
    func notAgain() {
        // Armed again with the same chains: at most once is per attached source.
        let run = Harness([chain])
        run.watermark = 12
        run.clock.advance(1)
        run.watermark = 32
        run.clock.advance(1)

        run.warmer.start([chain], leadSeconds: 10, warmBytes: 1024)
        let armed = run.samples
        run.clock.advance(10)
        #expect(run.samples == armed)
        #expect(run.warmed.count == 2)
    }

    @Test("an empty schedule list stops it")
    func emptyStops() {
        let run = Harness([chain])
        run.warmer.start([], leadSeconds: 10, warmBytes: 1024)
        run.watermark = 12
        run.clock.advance(5)
        #expect(run.samples == 0)
        #expect(run.warmed.isEmpty)
    }

    @Test("a run continuing in the same object needs nothing")
    func sameObject() {
        let run = Harness([[
            ChunkBoundary(url: "\(base)/media/v0_0.m4s", start: 0, end: 20),
            ChunkBoundary(url: "\(base)/media/v0_0.m4s", start: 20, end: 40),
            ChunkBoundary(url: "\(base)/media/v0_1.m4s", start: 40, end: 60),
        ]])
        run.watermark = 12
        run.clock.advance(1)
        #expect(run.warmed.isEmpty)
        run.watermark = 32
        run.clock.advance(1)
        #expect(run.warmed == ["\(base)/media/v0_1.m4s"])
    }

    @Test("reads schedules from the bridge, skipping incomplete boundaries")
    func readsSchedules() {
        let json: [JSON] = [
            .array([
                .object(["url": .string("a"), "start": .number(0), "end": .number(20)]),
                .object(["url": .string("b"), "start": .number(20)]),
            ]),
        ]
        #expect(ChunkBoundary.schedules(json) == [[ChunkBoundary(url: "a", start: 0, end: 20)]])
    }
}
