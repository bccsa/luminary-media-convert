import Testing
import LuminaryPlayerCore

/// Mirrors `chapterMask` and `formatChapterOf` in `player-web`, and Android's `ChapterCutsTest`.
@Suite("Chapter cuts")
struct ChapterCutsTests {
    private func chapter(_ start: Double, _ title: String? = nil) -> BrowseChapter {
        BrowseChapter(title: title ?? "at \(start)", start: start, end: start + 1)
    }

    @Test("a cut sits at each chapter start after the first")
    func cuts() {
        #expect(ChapterCuts.starts([chapter(0), chapter(10), chapter(40)], duration: 100) == [0.1, 0.4])
    }

    @Test("time before the first chapter is a stretch of its own")
    func leadingStretch() {
        #expect(ChapterCuts.starts([chapter(10)], duration: 100) == [0.1])
    }

    @Test("one stretch, no duration or a start past the end is one plain bar")
    func plainBar() {
        #expect(ChapterCuts.starts([chapter(0)], duration: 100).isEmpty)
        #expect(ChapterCuts.starts([chapter(0), chapter(10)], duration: 0).isEmpty)
        #expect(ChapterCuts.starts([chapter(0), chapter(500)], duration: 100).isEmpty)
    }

    @Test("duplicate starts are one cut")
    func duplicates() {
        #expect(ChapterCuts.starts([chapter(0), chapter(50), chapter(50)], duration: 100) == [0.5])
    }

    @Test("past sixty stretches the bar stays whole")
    func tooMany() {
        #expect(ChapterCuts.starts((0..<61).map { chapter(Double($0)) }, duration: 100).isEmpty)
    }

    @Test("a dense bar is cut with hairlines")
    func hairlines() {
        #expect(ChapterCuts.halfGap(stretches: 16) == 1.5)
        #expect(ChapterCuts.halfGap(stretches: 17) == 0.5)
    }

    @Test("the label says which chapter of how many, and its title")
    func label() {
        let chapters = [chapter(0, "Intro"), chapter(10, "")]
        #expect(ChapterCuts.nowText("Chapter {index} of {count}", chapters: chapters, index: 0) == "Chapter 1 of 2 · Intro")
        #expect(ChapterCuts.nowText("Chapitre {index} sur {count}", chapters: chapters, index: 1) == "Chapitre 2 sur 2")
    }

    @Test("there is no label for fewer than two chapters or none playing")
    func noLabel() {
        #expect(ChapterCuts.nowText("Chapter {index} of {count}", chapters: [chapter(0)], index: 0) == "")
        #expect(ChapterCuts.nowText("Chapter {index} of {count}", chapters: [chapter(0), chapter(1)], index: nil) == "")
    }

    @Test("the playhead is in the chapter whose span holds it, and in none between them")
    func chapterIndex() {
        let browse = Browse(chapters: [BrowseChapter(title: "a", start: 0, end: 10), BrowseChapter(title: "b", start: 20, end: 30)], upNext: [])
        #expect(browse.chapterIndex(at: 0) == 0)
        #expect(browse.chapterIndex(at: 10) == nil)
        #expect(browse.chapterIndex(at: 25) == 1)
    }
}

@Suite("Up-next strip")
struct NextUpTests {
    @Test("due in the last minute of a video with something on offer")
    func due() {
        #expect(!NextUp.due(offered: true, closed: false, live: false, duration: 300, position: 239))
        #expect(NextUp.due(offered: true, closed: false, live: false, duration: 300, position: 240))
    }

    @Test("never for live, an unknown length, a closed strip or nothing on offer")
    func notDue() {
        #expect(!NextUp.due(offered: true, closed: false, live: true, duration: 300, position: 290))
        #expect(!NextUp.due(offered: true, closed: false, live: false, duration: nil, position: 290))
        #expect(!NextUp.due(offered: true, closed: false, live: false, duration: 0, position: 0))
        #expect(!NextUp.due(offered: true, closed: true, live: false, duration: 300, position: 290))
        #expect(!NextUp.due(offered: false, closed: false, live: false, duration: 300, position: 290))
    }
}

@Suite("Full-screen browse arguments")
struct BrowseArgumentsTests {
    private func enter(_ browse: JSON?) -> [String: JSON] {
        var args: [String: JSON] = ["playerId": .string("player-1")]
        if let browse { args["browse"] = browse }
        return args
    }

    private func browse(_ call: BridgeCall) -> Browse? {
        guard case .enterFullscreen(_, _, let browse) = call else { return nil }
        return browse
    }

    private func refused(_ args: [String: JSON]) -> Bool {
        do {
            _ = try BridgeCall.decode("enterFullscreen", args)
            return false
        } catch let rejection as BridgeRejection {
            return rejection.code == .invalidArgument
        } catch {
            return false
        }
    }

    @Test("enterFullscreen carries the lists the panel shows, and they are optional")
    func decodes() throws {
        let lists = JSON.object([
            "chapters": .array([.object(["title": .string("Intro"), "startTime": .number(0), "endTime": .number(30)])]),
            "upNext": .array([.object(["id": .string("p2"), "title": .string("Next"), "subtitle": .string("Part 2"), "section": .string("Related")])]),
            "nextUp": .array([.object(["id": .string("p3"), "title": .string("After"), "fallbackImageUrl": .string("/assets/x.webp")])]),
        ])
        let decoded = try #require(browse(try BridgeCall.decode("enterFullscreen", enter(lists))))
        #expect(decoded.chapters == [BrowseChapter(title: "Intro", start: 0, end: 30)])
        #expect(decoded.upNext == [BrowseItem(id: "p2", title: "Next", subtitle: "Part 2", section: "Related")])
        #expect(decoded.nextUp == [BrowseItem(id: "p3", title: "After", fallbackImageUrl: "/assets/x.webp")])
        #expect(browse(try BridgeCall.decode("enterFullscreen", enter(nil))) == nil)
    }

    @Test("without nextUp the strip has nothing to offer")
    func nextUpOptional() throws {
        let lists = JSON.object(["chapters": .array([]), "upNext": .array([])])
        let decoded = try #require(browse(try BridgeCall.decode("enterFullscreen", enter(lists))))
        #expect(decoded.nextUp.isEmpty)
        #expect(decoded.isEmpty)
    }

    @Test("lists of the wrong shape are refused whole")
    func refusesBadShapes() {
        func chapters(_ entries: JSON...) -> JSON { .object(["chapters": .array(entries), "upNext": .array([])]) }
        #expect(refused(enter(.string("lists"))))
        #expect(refused(enter(.object(["chapters": .array([])]))))
        #expect(refused(enter(chapters(.object(["title": .string("x")])))))
        #expect(refused(enter(chapters(.object(["title": .string("x"), "startTime": .string("0"), "endTime": .number(1)])))))
        #expect(refused(enter(.object([
            "chapters": .array([]),
            "upNext": .array([.object(["id": .number(3), "title": .string("x")])]),
        ]))))
        #expect(refused(enter(.object(["chapters": .array([]), "upNext": .array([]), "nextUp": .string("x")]))))
    }

    @Test("the panel's texts take the host's language, and keep English for any not sent")
    func texts() {
        let texts = FullscreenTexts(overriding: ["chapters": "Chapitres", "chapterOf": "Chapitre {index} sur {count}"])
        #expect(texts.chapters == "Chapitres")
        #expect(texts.chapterOf == "Chapitre {index} sur {count}")
        #expect(texts.upNext == "Up next")
        #expect(texts.dismiss == "Dismiss")
    }
}

@Suite("Browse events")
struct BrowseEventsTests {
    private final class Log { var events: [(String, [String: JSON])] = [] }

    @Test("a pick in the panel, a pick in the strip and closing the strip are each a browseselect")
    func events() {
        let log = Log()
        let sink = EventSink(
            playerId: "p", clock: ManualClock(), variantSwitching: false,
            emit: { name, payload in log.events.append((name, payload)) }, position: { 0 }
        )
        sink.begin(loadId: "l1")

        sink.browseSelected(id: "a")
        sink.browseSelected(id: "b", kind: "nextup")
        sink.nextUpDismissed()

        let picks = log.events.filter { $0.0 == "browseselect" }.map(\.1)
        #expect(picks.count == 3)
        #expect(picks[0]["kind"] == .string("upnext"))
        #expect(picks[0]["id"] == .string("a"))
        #expect(picks[1]["kind"] == .string("nextup"))
        #expect(picks[1]["id"] == .string("b"))
        #expect(picks[2]["kind"] == .string("nextupdismiss"))
        #expect(picks[2]["id"] == nil)
        #expect(picks[2]["loadId"] == .string("l1"))
    }
}
