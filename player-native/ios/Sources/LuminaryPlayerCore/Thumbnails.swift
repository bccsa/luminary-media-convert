import Foundation

/// One frame of the scrub roster: the crop of a sprite sheet that covers `start` until `end`.
public struct ThumbnailCue: Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let url: String
    public let x: Int
    public let y: Int
    public let w: Int
    public let h: Int

    public init(start: Double, end: Double, url: String, x: Int, y: Int, w: Int, h: Int) {
        self.start = start
        self.end = end
        self.url = url
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/// `thumbnails.vtt` as the encoder writes it: WebVTT whose payload is a sprite sheet and an
/// `#xywh=` crop. A port of `parseThumbnailVtt` and `findThumbnailCue`
/// (`hls-core/src/thumbnail-vtt.ts`), which the web player's preview uses; the two have to read
/// the same file the same way.
public enum ThumbnailVtt {
    static func parseTime(_ text: String) -> Double {
        let parts = text.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return 0 }
        let seconds = parts[2].split(separator: ".", omittingEmptySubsequences: false)
        let fraction = seconds.count > 1 ? String(seconds[1]).padding(toLength: 3, withPad: "0", startingAt: 0) : "0"
        // Named parts: as one expression, the type checker gives up on slower machines.
        let hours: Double = Double(parts[0]) ?? 0
        let minutes: Double = Double(parts[1]) ?? 0
        let whole: Double = Double(seconds[0]) ?? 0
        let milliseconds: Double = Double(fraction.prefix(3)) ?? 0
        return hours * 3600 + minutes * 60 + whole + milliseconds / 1000
    }

    /// The cues of `text`, with sprite paths resolved against `baseUrl`, the directory of the VTT.
    public static func parse(_ text: String, baseUrl: String) -> [ThumbnailCue] {
        var cues = [ThumbnailCue]()
        let normalised = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        for block in normalised.components(separatedBy: "\n\n") {
            let lines = block.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
            guard let timeIndex = lines.firstIndex(where: { $0.contains(" --> ") }) else { continue }
            let times = lines[timeIndex].components(separatedBy: " --> ")
            guard timeIndex + 1 < lines.count else { continue }
            let payload = lines[timeIndex + 1].trimmingCharacters(in: .whitespaces)
            guard !payload.isEmpty else { continue }
            let fileRef = payload.components(separatedBy: "#")[0]
            let fragment = payload.contains("#") ? String(payload[payload.index(after: payload.firstIndex(of: "#")!)...]) : ""
            let url = fileRef.hasPrefix("http") ? fileRef : "\(baseUrl)/\(fileRef)"
            var box = [0, 0, 0, 0]
            if fragment.hasPrefix("xywh=") {
                let values = fragment.dropFirst("xywh=".count).split(separator: ",", omittingEmptySubsequences: false)
                for (i, value) in values.prefix(4).enumerated() {
                    box[i] = Int(Double(value.trimmingCharacters(in: .whitespaces)) ?? 0)
                }
            }
            cues.append(ThumbnailCue(
                start: parseTime(times[0]), end: parseTime(times.count > 1 ? times[1] : ""),
                url: url, x: box[0], y: box[1], w: box[2], h: box[3]
            ))
        }
        return cues
    }

    /// The cue covering `time`, or nil; binary search, because a scrub asks on every move.
    public static func find(_ cues: [ThumbnailCue], time: Double) -> ThumbnailCue? {
        var lo = 0
        var hi = cues.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            let cue = cues[mid]
            if time < cue.start {
                hi = mid - 1
            } else if time >= cue.end {
                lo = mid + 1
            } else {
                return cue
            }
        }
        return nil
    }
}

/// Where the roster's frames sit: a Swift port of `rosterStep` / `rosterTiles` in
/// `player-web/src/ui/scrubPreview.ts`, and of Android's `Roster`, so the strip slides the same way
/// everywhere.
public enum Roster {
    public struct Tile: Equatable {
        public let index: Int
        public let left: Double
        public let time: Double
    }

    public static func step(duration: Double) -> Double {
        min(max(duration / 120, 1), 15)
    }

    /// Where a pinned roster lands when it is dragged `dx` points from `startTime`: the strip follows the
    /// finger, so a drag to the right is back in time. Kept inside the media, a hair short of its end.
    public static func timeAfterDrag(startTime: Double, dx: Double, pointsPerSecond: Double, duration: Double) -> Double {
        guard pointsPerSecond > 0 else { return startTime }
        return min(max(startTime - dx / pointsPerSecond, 0), max(duration - 0.001, 0))
    }

    public static func tiles(
        time: Double, markerX: Double, width: Double, tileWidth: Double, step: Double, duration: Double
    ) -> [Tile] {
        guard width > 0, tileWidth > 0, step > 0, duration > 0 else { return [] }
        let perSecond = tileWidth / step
        let first = Int(((time - markerX / perSecond) / step).rounded(.down))
        let last = Int(((time + (width - markerX) / perSecond) / step).rounded(.up))
        var tiles = [Tile]()
        for index in first...max(first, last) {
            let start = Double(index) * step
            if start >= duration || start + step <= 0 { continue }
            tiles.append(Tile(
                index: index,
                left: markerX + (start - time) * perSecond,
                time: min(max(start + step / 2, 0), max(duration - 0.001, 0))
            ))
        }
        return tiles
    }
}

/// The frames the full-screen controls draw under a held timeline. Fetched by native, not sent by
/// JavaScript, so the roster works while JavaScript is frozen: the VTT is read (and decrypted when
/// it is LMCENC, with the load's key), and the sprite sheets are fetched the first time a frame on
/// one is wanted. Every failure leaves no frames, which is what a source without any looks like.
public final class Thumbnails: @unchecked Sendable {
    public typealias Reader = @Sendable (String, @escaping @Sendable (Data?) -> Void) -> Void

    private let read: Reader
    private let lock = NSLock()
    private var cues: [ThumbnailCue] = []
    private var asked = Set<String>()
    private let sheets = NSCache<NSString, NSData>()
    /// Bumped on every load, so a read that finishes for an earlier one is discarded.
    private var generation = 0

    /// Called on the main queue when the VTT has arrived or a sheet has, so a view can draw again.
    public var onChange: (() -> Void)?

    public init(read: @escaping Reader = Thumbnails.fetch) {
        self.read = read
        sheets.totalCostLimit = 24 * 1024 * 1024
    }

    public var ready: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !cues.isEmpty
    }

    /// Starts reading `url` (nil: no frames). `keyHex` is the LMCENC key.
    public func load(url: String?, keyHex: String?) {
        lock.lock()
        generation += 1
        let mine = generation
        cues = []
        asked.removeAll()
        lock.unlock()
        sheets.removeAllObjects()
        notify()
        guard let url else { return }
        read(url) { [weak self] bytes in
            guard let self, let bytes else { return }
            let plain: Data?
            if Lmcenc.isEncrypted(bytes) {
                plain = keyHex.flatMap { Lmcenc.decrypt(bytes, keyHex: $0) }
            } else {
                plain = bytes
            }
            guard let plain else { return }
            var text = String(decoding: plain, as: UTF8.self)
            if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
            let parsed = ThumbnailVtt.parse(text, baseUrl: url.components(separatedBy: "/").dropLast().joined(separator: "/"))
            self.lock.lock()
            let current = mine == self.generation
            if current { self.cues = parsed }
            self.lock.unlock()
            if current { self.notify() }
        }
    }

    public func cue(at time: Double) -> ThumbnailCue? {
        lock.lock()
        defer { lock.unlock() }
        return ThumbnailVtt.find(cues, time: time)
    }

    /// The first frame's crop shape, which every frame of an encode shares; nil until there are frames.
    public func sample() -> ThumbnailCue? {
        lock.lock()
        defer { lock.unlock() }
        return cues.first { $0.w > 0 && $0.h > 0 }
    }

    /// The sheet `cue` is on if it is in memory; otherwise nil, and the fetch starts.
    public func sheet(for cue: ThumbnailCue) -> Data? {
        if let data = sheets.object(forKey: cue.url as NSString) { return data as Data }
        lock.lock()
        let mine = generation
        let start = asked.insert(cue.url).inserted
        lock.unlock()
        if start {
            read(cue.url) { [weak self] bytes in
                guard let self else { return }
                self.lock.lock()
                let current = mine == self.generation
                if bytes == nil { self.asked.remove(cue.url) }
                self.lock.unlock()
                guard current, let bytes else { return }
                self.sheets.setObject(bytes as NSData, forKey: cue.url as NSString, cost: bytes.count)
                self.notify()
            }
        }
        return nil
    }

    public func release() {
        lock.lock()
        generation += 1
        cues = []
        lock.unlock()
        sheets.removeAllObjects()
        onChange = nil
    }

    private func notify() {
        DispatchQueue.main.async { [weak self] in self?.onChange?() }
    }

    /// A plain GET; nil on anything but a 200.
    public static let fetch: Reader = { url, done in
        guard let address = URL(string: url) else { return done(nil) }
        var request = URLRequest(url: address, timeoutInterval: 15)
        request.cachePolicy = .returnCacheDataElseLoad
        URLSession.shared.dataTask(with: request) { data, response, _ in
            done((response as? HTTPURLResponse)?.statusCode == 200 ? data : nil)
        }.resume()
    }
}
