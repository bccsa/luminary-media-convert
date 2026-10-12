import Foundation
import Testing
import LuminaryPlayerCore

/// The scrub frames' VTT, read the way `hls-core`'s `parseThumbnailVtt` reads it, and the roster's
/// arithmetic. Mirrors `ThumbnailsTest` on Android.
@Suite("Thumbnails")
struct ThumbnailsTests {
    private let vtt = """
        WEBVTT

        00:00:00.000 --> 00:00:01.000
        sprite_0.webp#xywh=0,0,160,90

        00:00:01.000 --> 00:00:02.500
        sprite_0.webp#xywh=160,0,160,90

        00:01:00.000 --> 00:01:01.000
        https://cdn.example.com/other.webp#xywh=0,90,160,90
        """

    @Test("cues come back in order, sprite paths resolved against the VTT's folder")
    func cues() {
        let cues = ThumbnailVtt.parse(vtt, baseUrl: "https://bucket.example.com/abc/thumbnails")

        #expect(cues.count == 3)
        #expect(cues[0].url == "https://bucket.example.com/abc/thumbnails/sprite_0.webp")
        #expect(cues[1] == ThumbnailCue(
            start: 1, end: 2.5, url: "https://bucket.example.com/abc/thumbnails/sprite_0.webp",
            x: 160, y: 0, w: 160, h: 90
        ))
        #expect(cues[2].url == "https://cdn.example.com/other.webp")
        #expect(cues[2].start == 60)
    }

    @Test("a file with CRLF line endings is still every cue, not the first")
    func crlf() {
        #expect(ThumbnailVtt.parse(vtt.replacingOccurrences(of: "\n", with: "\r\n"), baseUrl: "base").count == 3)
    }

    @Test("a lookup lands on the cue that covers the time, ends being exclusive")
    func lookup() {
        let cues = ThumbnailVtt.parse(vtt, baseUrl: "base")

        #expect(ThumbnailVtt.find(cues, time: 0.5)?.start == 0)
        #expect(ThumbnailVtt.find(cues, time: 1)?.start == 1)
        #expect(ThumbnailVtt.find(cues, time: 2.4)?.start == 1)
        #expect(ThumbnailVtt.find(cues, time: 2.5) == nil)
        #expect(ThumbnailVtt.find(cues, time: 60.5) != nil)
        #expect(ThumbnailVtt.find([], time: 1) == nil)
    }

    @Test("a cue with no crop is the whole image")
    func wholeImage() {
        let cues = ThumbnailVtt.parse("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nframe.webp\n", baseUrl: "base")

        #expect(cues.count == 1)
        #expect(cues[0].w == 0)
    }

    @Test("the roster keeps each slot on its own time while the playhead moves")
    func slotsStay() throws {
        let a = Roster.tiles(time: 100, markerX: 200, width: 800, tileWidth: 100, step: 10, duration: 1000)
        let b = Roster.tiles(time: 105, markerX: 200, width: 800, tileWidth: 100, step: 10, duration: 1000)
        let tenA = try #require(a.first { $0.index == 10 })
        let tenB = try #require(b.first { $0.index == 10 })

        #expect(tenA.time == tenB.time)
        #expect(abs((tenA.left - tenB.left) - 50) < 0.001)
    }

    @Test("the playhead is under the marker")
    func underMarker() throws {
        let tiles = Roster.tiles(time: 100, markerX: 200, width: 800, tileWidth: 100, step: 10, duration: 1000)
        let under = try #require(tiles.first { $0.left <= 200 && $0.left + 100 > 200 })

        #expect(under.time - 5 <= 100 && under.time + 5 > 100)
    }

    @Test("slots outside the media are left out")
    func outside() {
        let tiles = Roster.tiles(time: 2, markerX: 400, width: 800, tileWidth: 100, step: 10, duration: 30)

        #expect(tiles.allSatisfy { $0.time >= 0 && $0.time < 30 })
        #expect(tiles.map(\.index).min() == 0)
        #expect(tiles.map(\.index).max() == 2)
        #expect(Roster.tiles(time: 0, markerX: 0, width: 0, tileWidth: 100, step: 10, duration: 100).isEmpty)
    }

    @Test("a frame is a second to a clip and fifteen at most to a long one")
    func step() {
        #expect(Roster.step(duration: 30) == 1)
        #expect(Roster.step(duration: 1200) == 10)
        #expect(Roster.step(duration: 100_000) == 15)
    }

    @Test("the pinned roster's frames are a quarter of the held ones, and never under half a second")
    func fineStep() {
        #expect(Roster.fineStep(duration: 1200) == 2.5)
        #expect(Roster.fineStep(duration: 100_000) == 3.75)
        #expect(Roster.fineStep(duration: 30) == 0.5)
    }

    @Test("dragging the pinned roster right goes back in time, within the media")
    func dragTime() {
        #expect(Roster.timeAfterDrag(startTime: 100, dx: 50, pointsPerSecond: 25, duration: 1000) == 98)
        #expect(Roster.timeAfterDrag(startTime: 100, dx: -50, pointsPerSecond: 25, duration: 1000) == 102)
        #expect(Roster.timeAfterDrag(startTime: 1, dx: 500, pointsPerSecond: 25, duration: 1000) == 0)
        #expect(Roster.timeAfterDrag(startTime: 999, dx: -500, pointsPerSecond: 25, duration: 1000) == 999.999)
    }

    @Test("a tap names the frame it lands on, by its distance from the marker")
    func tapTime() {
        #expect(Roster.timeAtTap(time: 100, x: 250, markerX: 200, pointsPerSecond: 25, duration: 1000) == 102)
        #expect(Roster.timeAtTap(time: 100, x: 150, markerX: 200, pointsPerSecond: 25, duration: 1000) == 98)
        #expect(Roster.timeAtTap(time: 100, x: 200, markerX: 200, pointsPerSecond: 25, duration: 1000) == 100)
    }

    @Test("the loader reads the VTT, then a sheet on the first ask for one of its frames")
    func loader() async throws {
        let asked = Asked()
        let thumbnails = Thumbnails { url, done in
            asked.add(url)
            done(url.hasSuffix(".vtt") ? Data(vtt.utf8) : Data([1, 2, 3]))
        }

        thumbnails.load(url: "https://cdn.example.com/t/thumbnails.vtt", keyHex: nil)
        #expect(thumbnails.ready)
        let cue = try #require(thumbnails.cue(at: 0.5))
        #expect(cue.url == "https://cdn.example.com/t/sprite_0.webp")

        #expect(thumbnails.sheet(for: cue) == nil)
        #expect(thumbnails.sheet(for: cue) == Data([1, 2, 3]))
        #expect(asked.urls == ["https://cdn.example.com/t/thumbnails.vtt", "https://cdn.example.com/t/sprite_0.webp"])
    }

    @Test("a source without frames, or a failed read, leaves none")
    func noFrames() {
        let none = Thumbnails { _, done in done(nil) }
        none.load(url: nil, keyHex: nil)
        #expect(!none.ready)
        none.load(url: "https://cdn.example.com/t/thumbnails.vtt", keyHex: nil)
        #expect(!none.ready)
    }

    @Test("an encrypted VTT without its key leaves none")
    func encryptedWithoutKey() {
        let locked = Thumbnails { _, done in done(Data("LMCENC01".utf8) + Data(count: 48)) }
        locked.load(url: "https://cdn.example.com/t/thumbnails.vtt", keyHex: nil)
        #expect(!locked.ready)
    }
}

private final class Asked: @unchecked Sendable {
    private let lock = NSLock()
    private var list = [String]()
    func add(_ url: String) { lock.lock(); list.append(url); lock.unlock() }
    var urls: [String] { lock.lock(); defer { lock.unlock() }; return list }
}
