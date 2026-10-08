import Foundation

/// One run of segments sharing a chunk object, in media time: `ChunkBoundary` in `player-core`.
public struct ChunkBoundary: Equatable, Sendable {
    public let url: String
    public let start: Double
    public let end: Double

    public init(url: String, start: Double, end: Double) {
        self.url = url
        self.start = start
        self.end = end
    }

    /// From `warmChunks`' arguments, which the bridge checks only for shape. A boundary missing
    /// a field is skipped: warming is advisory, and an incomplete schedule warms less.
    public static func schedules(_ json: [JSON]) -> [[ChunkBoundary]] {
        json.map { schedule in
            guard case .array(let boundaries) = schedule else { return [] }
            return boundaries.compactMap { boundary in
                guard let url = boundary["url"]?.stringValue,
                      let start = boundary["start"]?.numberValue,
                      let end = boundary["end"]?.numberValue else { return nil }
                return ChunkBoundary(url: url, start: start, end: end)
            }
        }
    }
}

/// The chunk-warming loop, ported from `player-web/src/adapter/chunkWarming.ts` and following the
/// nine rules of `docs/chunk-warming.md`. It runs beside the engine, on the main thread's clock,
/// so it keeps warming while JavaScript is frozen.
///
/// About once a second it reads the buffer front (`max(bufferedEnd, currentTime)`); when that is
/// within `leadSeconds` of the end of the run it is in, it asks for the first `warmBytes` of the
/// next chunk object, so the edge pulls it before the engine crosses into it. Each chunk is
/// warmed at most once, a chain's first never, and failures are swallowed. It stops itself once
/// nothing is left to warm. One warmer serves one load: ``PlayerHost`` makes a new one for each.
public final class ChunkWarmer {
    /// Requests `Range: bytes=0-<bytes - 1>` of a URL and discards the answer.
    public typealias Fetch = (_ url: URL, _ bytes: Int) -> Void

    static let interval: Double = 1

    private let clock: Clock
    private let watermark: () -> Double
    private let fetch: Fetch
    /// Chunk URLs already asked for, across every arming of this warmer.
    private var warmed: Set<String> = []
    /// Chunk URLs the armed schedules could still warm.
    private var unwarmed: Set<String> = []
    private var schedules: [[ChunkBoundary]] = []
    private var leadSeconds: Double = 60
    private var warmBytes = 65_536
    private var timer: Cancellable?

    public init(clock: Clock, watermark: @escaping () -> Double, fetch: @escaping Fetch = ChunkWarmer.urlSessionFetch) {
        self.clock = clock
        self.watermark = watermark
        self.fetch = fetch
    }

    /// Arms the loop for these chains; an empty list stops it. It ticks while paused: a player
    /// parked short of a boundary gets the next chunk warmed before play is pressed again.
    public func start(_ schedules: [[ChunkBoundary]], leadSeconds: Double, warmBytes: Int) {
        stop()
        self.schedules = schedules
        self.leadSeconds = leadSeconds
        self.warmBytes = max(warmBytes, 1)
        unwarmed = Self.warmableUrls(schedules, excluding: warmed)
        guard !unwarmed.isEmpty else { return }
        schedule()
    }

    public func stop() {
        timer?.cancel()
        timer = nil
        schedules = []
    }

    /// Whether the loop is sampling; for tests.
    var ticking: Bool { timer != nil }

    private func schedule() {
        timer = clock.schedule(Self.interval) { [weak self] in self?.tick() }
    }

    private func tick() {
        timer = nil
        let front = watermark()
        if front.isFinite {
            for schedule in schedules {
                guard let index = schedule.firstIndex(where: { front >= $0.start && front < $0.end }) else { continue }
                let current = schedule[index]
                guard current.end - front <= leadSeconds, index + 1 < schedule.count else { continue }
                let next = schedule[index + 1]
                // A run continuing in the same object needs nothing.
                guard next.url != current.url else { continue }
                warm(next.url)
            }
        }
        // That was the last one: nothing is left for this load.
        if unwarmed.isEmpty {
            schedules = []
            return
        }
        schedule()
    }

    private func warm(_ url: String) {
        // Marked before the request, and never retried: the engine's own request is the fallback.
        guard warmed.insert(url).inserted else { return }
        unwarmed.remove(url)
        if let target = URL(string: url) { fetch(target, warmBytes) }
    }

    /// Each boundary whose chunk differs from the one before it, a chain's first excepted.
    static func warmableUrls(_ schedules: [[ChunkBoundary]], excluding warmed: Set<String>) -> Set<String> {
        var urls = Set<String>()
        for schedule in schedules where schedule.count > 1 {
            for i in 1..<schedule.count where schedule[i].url != schedule[i - 1].url && !warmed.contains(schedule[i].url) {
                urls.insert(schedule[i].url)
            }
        }
        return urls
    }

    /// The request that warms a chunk: `Range: bytes=0-<bytes - 1>`, never from the cache, and not
    /// on a constrained network. Low Data Mode is the viewer's own data saver, and a warm is an
    /// extra request nobody asked for: it is skipped there, and the engine's own request is the
    /// fallback, as it is for every warm that does not happen.
    static func warmRequest(_ url: URL, bytes: Int) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("bytes=0-\(bytes - 1)", forHTTPHeaderField: "Range")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.allowsConstrainedNetworkAccess = false
        return request
    }

    /// The bytes are discarded ciphertext, read to completion and dropped; every failure is
    /// swallowed. Nothing is cached, so the request reaches the edge.
    public static let urlSessionFetch: Fetch = { url, bytes in
        URLSession.shared.dataTask(with: warmRequest(url, bytes: bytes)) { _, _, _ in }.resume()
    }
}
