import Foundation

/// A chapter in full-screen's panel: tapping it seeks to `start`, in seconds.
public struct BrowseChapter: Sendable, Equatable {
    public let title: String
    public let start: Double
    public let end: Double

    public init(title: String, start: Double, end: Double) {
        self.title = title
        self.start = start
        self.end = end
    }
}

/// A video offered after this one; `section` is the heading above each run of items that share it.
public struct BrowseItem: Sendable, Equatable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let imageUrl: String?
    public let section: String?
    /// Drawn when there is no picture, or it does not load.
    public let fallbackImageUrl: String?

    public init(id: String, title: String, subtitle: String? = nil, imageUrl: String? = nil, section: String? = nil, fallbackImageUrl: String? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.imageUrl = imageUrl
        self.section = section
        self.fallbackImageUrl = fallbackImageUrl
    }
}

/// What full-screen's chapters / up-next panel lists, and the videos its strip offers near the end.
public struct Browse: Sendable, Equatable {
    public let chapters: [BrowseChapter]
    public let upNext: [BrowseItem]
    public let nextUp: [BrowseItem]

    public init(chapters: [BrowseChapter], upNext: [BrowseItem], nextUp: [BrowseItem] = []) {
        self.chapters = chapters
        self.upNext = upNext
        self.nextUp = nextUp
    }

    /// Of the panel: the strip has no button of its own.
    public var isEmpty: Bool { chapters.isEmpty && upNext.isEmpty }

    /// The chapter the playhead is in; nil between chapters or with none.
    public func chapterIndex(at seconds: Double) -> Int? {
        chapters.firstIndex { seconds >= $0.start && seconds < $0.end }
    }
}

/// How the timeline is cut at chapter starts: the web player's `chapterMask` and `formatChapterOf`, so a bar
/// reads the same everywhere.
public enum ChapterCuts {
    /// Past this many stretches the gap gives way to a hairline.
    public static let dense = 16
    /// Past this many a cut every few points is noise, and the bar stays one plain bar.
    public static let max = 60
    /// Half the gap between two chapters, in points at the normal scale.
    public static let halfGap: Double = 1.5
    /// The same for a bar with many chapters.
    public static let halfHairline: Double = 0.5

    /// Where each chapter after the first starts, as a fraction of the bar; empty when the bar stays whole.
    public static func starts(_ chapters: [BrowseChapter], duration: Double) -> [Double] {
        guard duration > 0 else { return [] }
        var times = Array(Set(chapters.map { Swift.max($0.start, 0) }.filter { $0 < duration })).sorted()
        guard let first = times.first else { return [] }
        // Time before the first chapter is a stretch of its own.
        if first > 0 { times.insert(0, at: 0) }
        guard times.count >= 2, times.count <= max else { return [] }
        return times.dropFirst().map { $0 / duration }
    }

    /// Half the gap, in points at the normal scale, for a bar of `stretches` stretches.
    public static func halfGap(stretches: Int) -> Double { stretches > dense ? halfHairline : halfGap }

    /// "Chapter 4 of 7", with the chapter's title after it when it has one.
    public static func nowText(_ template: String, chapters: [BrowseChapter], index: Int?) -> String {
        guard chapters.count >= 2, let index, chapters.indices.contains(index) else { return "" }
        let head = template
            .replacingOccurrences(of: "{index}", with: "\(index + 1)")
            .replacingOccurrences(of: "{count}", with: "\(chapters.count)")
        let title = chapters[index].title
        return title.isEmpty ? head : "\(head) · \(title)"
    }
}

/// When the strip of next videos is offered: the web player's rule, so full-screen counts down to the end the same way.
public enum NextUp {
    /// The strip is up once this much or less of the video is left.
    public static let leadSeconds: Double = 60
    /// Room for this many cards.
    public static let max = 5

    /// Whether the strip is due. Live and not-yet-known lengths have no end to count down to, and a strip the
    /// viewer closed, or one with nothing on offer, stays away.
    public static func due(offered: Bool, closed: Bool, live: Bool, duration: Double?, position: Double) -> Bool {
        guard offered, !closed, !live, let duration, duration > 0 else { return false }
        return duration - position <= leadSeconds
    }
}
