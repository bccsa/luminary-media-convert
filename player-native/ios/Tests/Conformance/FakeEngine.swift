import LuminaryPlayerCore

/// The `FakeEngine` of `conformance/README.md`, the same on Android. A command only records
/// itself; nothing changes until a signal says so.
final class FakeEngine: Engine {
    var events: EventSink?
    private(set) var hasVideo = true

    private let clock: Clock
    /// Shared by every engine a harness creates, so the harness drains one list.
    private let log: (JSON) -> Void
    private var basePosition = 0.0
    private var baseTime = 0.0
    private var rate = 1.0
    private var playing = false
    private var duration: Double? = 0
    private var bufferedEnd = 0.0

    init(clock: Clock, log: @escaping (JSON) -> Void) {
        self.clock = clock
        self.log = log
    }

    // MARK: Commands: recorded, never acted on

    func load(masterUri: String, startPosition: Double?, nowPlaying: NowPlaying?, recovery: RecoveryPolicy) {
        var args: [String: JSON] = ["masterUri": .string(masterUri)]
        if let startPosition { args["startPosition"] = .number(startPosition) }
        record("load", args)
        playing = false
        setPosition(startPosition ?? 0)
        duration = 0
        bufferedEnd = 0
        hasVideo = true
    }

    func reattach() { record("reattach") }
    func play() { record("play") }
    func pause() { record("pause") }
    func seek(position: Double, exact: Bool) {
        record("seek", ["position": .number(position), "exact": .bool(exact)])
    }
    func setRate(_ rate: Double) { record("setRate", ["rate": .number(rate)]) }
    func setVariant(_ id: String) { record("setVariant", ["id": .string(id)]) }
    func setAudioTrack(_ id: String) { record("setAudioTrack", ["id": .string(id)]) }
    func setAppSuspended(_ suspended: Bool) {}
    func takeHeldReload() -> PendingReload? { nil }
    func setMuted(_ muted: Bool) { record("setMuted", ["muted": .bool(muted)]) }
    func setSubtitleTrack(_ label: String?) {
        guard let label else { return record("setSubtitleTrack") }
        record("setSubtitleTrack", ["label": .string(label)])
    }
    func startPictureInPicture() { record("startPictureInPicture") }
    func setInlineFrame(_ frame: InlineFrame?) {
        guard let frame else { return record("setInlineFrame") }
        record("setInlineFrame", [
            "x": .number(frame.x), "y": .number(frame.y), "width": .number(frame.width), "height": .number(frame.height),
        ])
    }
    func enterFullscreen() { record("enterFullscreen") }
    func exitFullscreen() { record("exitFullscreen") }
    func destroy() { record("destroy") }

    func snapshot() -> Snapshot {
        Snapshot(currentTime: position(), duration: duration, bufferedEnd: bufferedEnd, playing: playing)
    }

    private func position() -> Double {
        playing ? basePosition + (clock.now() - baseTime) * rate : basePosition
    }

    // MARK: Signals: the engine's side of the story

    func signal(_ signal: String, _ args: [String: JSON]) {
        switch signal {
        case "readyToPlay":
            switch args["duration"] {
            case nil: duration = 0
            case .null?: duration = nil
            case let value?: duration = value.numberValue
            }
            hasVideo = args["hasVideo"] != .bool(false)
            events?.readyToPlay(duration: duration)
        case "playing":
            setPosition(position())
            playing = true
            events?.playing()
        case "paused":
            setPosition(position())
            playing = false
            events?.paused()
        case "buffering":
            events?.buffering()
        case "seeked":
            setPosition(args["position"]?.numberValue ?? 0)
            events?.seeked()
        case "ended":
            setPosition(position())
            playing = false
            events?.ended()
        case "tracks":
            let tracks = Self.items(args["tracks"]).map { track in
                AudioTrack(
                    id: track["id"]?.stringValue ?? "",
                    lang: track["lang"]?.stringValue,
                    label: track["label"]?.stringValue ?? ""
                )
            }
            events?.audioTracks(tracks, activeId: args["activeId"]?.stringValue)
        case "variants":
            let variants = Self.items(args["variants"]).map { variant in
                Variant(
                    id: variant["id"]?.stringValue ?? "",
                    height: variant["height"]?.numberValue.map { Int($0) },
                    bandwidth: Int(variant["bandwidth"]?.numberValue ?? 0)
                )
            }
            events?.variants(variants)
        case "bufferedTo":
            bufferedEnd = args["end"]?.numberValue ?? 0
            events?.bufferedTo(bufferedEnd)
        case "position":
            setPosition(args["position"]?.numberValue ?? 0)
        case "muted":
            if case .bool(let muted)? = args["muted"] { events?.mutedChanged(muted) }
        case "rate":
            setPosition(position())
            rate = args["rate"]?.numberValue ?? 1
            events?.rateChanged(rate)
        case "failed":
            preconditionFailure("failed: the recovery ladder arrives in phase 3")
        default:
            preconditionFailure("Unknown engine signal \(signal)")
        }
    }

    private func setPosition(_ position: Double) {
        basePosition = position
        baseTime = clock.now()
    }

    private func record(_ method: String, _ args: [String: JSON] = [:]) {
        var entry = args
        entry["method"] = .string(method)
        log(.object(entry))
    }

    private static func items(_ value: JSON?) -> [JSON] {
        if case .array(let items)? = value { return items }
        return []
    }
}
