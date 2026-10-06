import Foundation

// The bridge contract, mirrored by hand from `player-native/src/bridge.ts` (the source of
// truth), and the one place a call's JSON is decoded and validated. The plugin and the
// conformance harness both enter here, so the scenarios test the path the app runs.

public let protocolVersion = 1
public let assetUriPrefix = "luminary://asset/"
public let keyUri = "luminary://key"
public let liveUriPrefix = "luminary://live/"

/// The only codes native passes to `call.reject(message, code)`.
public enum BridgeErrorCode: String, Sendable {
    case unsupported
    case unknownPlayer = "unknown-player"
    case staleGeneration = "stale-generation"
    case invalidArgument = "invalid-argument"
    case protocolMismatch = "protocol-mismatch"
    case engine
}

/// A refused call. A refused call changes nothing.
public struct BridgeRejection: Error, Sendable {
    public let code: BridgeErrorCode
    public let message: String

    public init(_ code: BridgeErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

public struct BridgeCapabilities: Sendable {
    public var variantSwitching = false
    public var pictureInPicture = false
    public var renderText = false
    public var live = false
    public var chunkWarming = false
    public var backgroundAudio = false
    public var inlineVideo = false
    public var maxPlayers = 1

    public init() {}

    /// A missing or mistyped flag reads as false; a missing `maxPlayers` as 1.
    public init(json: [String: JSON]) {
        func flag(_ key: String) -> Bool {
            if case .bool(let value)? = json[key] { return value }
            return false
        }
        variantSwitching = flag("variantSwitching")
        pictureInPicture = flag("pictureInPicture")
        renderText = flag("renderText")
        live = flag("live")
        chunkWarming = flag("chunkWarming")
        backgroundAudio = flag("backgroundAudio")
        inlineVideo = flag("inlineVideo")
        maxPlayers = json["maxPlayers"]?.numberValue.map { Int($0) } ?? 1
    }

    public var json: JSON {
        .object([
            "variantSwitching": .bool(variantSwitching),
            "pictureInPicture": .bool(pictureInPicture),
            "renderText": .bool(renderText),
            "live": .bool(live),
            "chunkWarming": .bool(chunkWarming),
            "backgroundAudio": .bool(backgroundAudio),
            "inlineVideo": .bool(inlineVideo),
            "maxPlayers": .number(Double(maxPlayers)),
        ])
    }
}

/// One served asset. Text travels as text, never base64.
public struct BridgeAsset: Sendable {
    public let uri: String
    public let contentType: String
    public let text: String
}

public struct NowPlaying: Sendable {
    public let title: String
    public let subtitle: String?
    public let artworkUrl: String?
}

/// Resolved by `player-core`: native applies it, never defaults it.
public struct RecoveryPolicy: Sendable {
    public let escalationWindowMs: Double
    public let maxReloadAttempts: Int
    public let reloadDelaysMs: [Double]

    public init(escalationWindowMs: Double, maxReloadAttempts: Int, reloadDelaysMs: [Double]) {
        self.escalationWindowMs = escalationWindowMs
        self.maxReloadAttempts = maxReloadAttempts
        self.reloadDelaysMs = reloadDelaysMs
    }

    /// `player-core`'s `DEFAULT_RECOVERY_POLICY`, until a load hands over its own.
    public static let `default` = RecoveryPolicy(
        escalationWindowMs: 10_000,
        maxReloadAttempts: 3,
        reloadDelaysMs: [2_000, 4_000, 8_000]
    )
}

public struct BridgeLiveSpec: Sendable {
    public let url: String
    public let baseUrl: String
    public let keyUri: String?
    public let keyHex: String?
    public let refreshSec: Double
}

public struct CreateOptions: Sendable {
    public let protocolVersion: Double
    public let skipBackSeconds: Double
    public let skipForwardSeconds: Double

    public init(protocolVersion: Double, skipBackSeconds: Double, skipForwardSeconds: Double) {
        self.protocolVersion = protocolVersion
        self.skipBackSeconds = skipBackSeconds
        self.skipForwardSeconds = skipForwardSeconds
    }
}

public struct LoadArgs: Sendable {
    public let playerId: String
    public let loadId: String
    public let generation: Int
    public let masterUri: String
    public let assets: [BridgeAsset]
    public let keyHex: String?
    public let startPosition: Double?
    public let recovery: RecoveryPolicy
    public let nowPlaying: NowPlaying?
}

public struct Snapshot: Sendable {
    public let currentTime: Double
    /// 0 until known; nil while unbounded (live).
    public let duration: Double?
    public let bufferedEnd: Double
    public let playing: Bool

    public init(currentTime: Double, duration: Double?, bufferedEnd: Double, playing: Bool) {
        self.currentTime = currentTime
        self.duration = duration
        self.bufferedEnd = bufferedEnd
        self.playing = playing
    }

    public var json: JSON {
        .object([
            "currentTime": .number(currentTime),
            "duration": duration.map(JSON.number) ?? .null,
            "bufferedEnd": .number(bufferedEnd),
            "playing": .bool(playing),
        ])
    }
}

public struct PendingReload: Sendable, Equatable {
    public let reason: String
    public let attempt: Int

    public init(reason: String, attempt: Int) {
        self.reason = reason
        self.attempt = attempt
    }
}

public struct ResumeResult: Sendable {
    public let loadId: String?
    public let snapshot: Snapshot
    public let pendingReload: PendingReload?

    public var json: JSON {
        var object: [String: JSON] = [
            "loadId": loadId.map(JSON.string) ?? .null,
            "snapshot": snapshot.json,
        ]
        if let pendingReload {
            object["pendingReload"] = .object([
                "reason": .string(pendingReload.reason),
                "attempt": .number(Double(pendingReload.attempt)),
            ])
        }
        return .object(object)
    }
}

/// `AdapterAudioTrack` in `player-core`.
public struct AudioTrack: Sendable {
    public let id: String
    public let lang: String?
    public let label: String

    public init(id: String, lang: String?, label: String) {
        self.id = id
        self.lang = lang
        self.label = label
    }

    public var json: JSON {
        var object: [String: JSON] = ["id": .string(id), "label": .string(label)]
        if let lang { object["lang"] = .string(lang) }
        return .object(object)
    }
}

/// `AdapterVariant` in `player-core`.
public struct Variant: Sendable {
    public let id: String
    public let height: Int?
    public let bandwidth: Int

    public init(id: String, height: Int?, bandwidth: Int) {
        self.id = id
        self.height = height
        self.bandwidth = bandwidth
    }

    public var json: JSON {
        var object: [String: JSON] = ["id": .string(id), "bandwidth": .number(Double(bandwidth))]
        if let height { object["height"] = .number(Double(height)) }
        return .object(object)
    }
}

// MARK: - Calls

/// One decoded, validated call.
public enum BridgeCall: Sendable {
    case getInfo
    case reset
    case create(CreateOptions)
    case load(LoadArgs)
    case putAssets(playerId: String, generation: Int, assets: [BridgeAsset])
    case putLive(playerId: String, generation: Int, uri: String, spec: BridgeLiveSpec)
    case releaseAssets(playerId: String, generation: Int)
    case reattach(playerId: String, loadId: String)
    case play(playerId: String)
    case pause(playerId: String)
    case seek(playerId: String, position: Double, exact: Bool)
    case setRate(playerId: String, rate: Double)
    case setVariant(playerId: String, id: String)
    case setAudioTrack(playerId: String, id: String)
    case warmChunks(playerId: String, loadId: String, schedules: [JSON], leadSeconds: Double, warmBytes: Int)
    case setInlineFrame(playerId: String, frame: InlineFrame?)
    case enterFullscreen(playerId: String)
    case exitFullscreen(playerId: String)
    case resumed(playerId: String)
    case destroy(playerId: String)

    /// The player a call names; nil for the calls that name none.
    public var playerId: String? {
        switch self {
        case .getInfo, .reset, .create: return nil
        case .load(let args): return args.playerId
        case .putAssets(let id, _, _), .putLive(let id, _, _, _), .releaseAssets(let id, _),
             .reattach(let id, _), .play(let id), .pause(let id), .seek(let id, _, _),
             .setRate(let id, _), .setVariant(let id, _), .setAudioTrack(let id, _),
             .warmChunks(let id, _, _, _, _), .setInlineFrame(let id, _), .enterFullscreen(let id), .exitFullscreen(let id),
             .resumed(let id), .destroy(let id):
            return id
        }
    }

    /// The capability each gated method needs; checked before its arguments are looked at.
    public static func capability(of method: String) -> KeyPath<BridgeCapabilities, Bool>? {
        switch method {
        case "setVariant": return \.variantSwitching
        case "putLive": return \.live
        case "warmChunks": return \.chunkWarming
        case "setInlineFrame": return \.inlineVideo
        default: return nil
        }
    }

    /// Throws a ``BridgeRejection`` with `invalid-argument`, or `unsupported` for a method the
    /// bridge lacks.
    public static func decode(_ method: String, _ json: [String: JSON]) throws -> BridgeCall {
        let args = Args(json, path: method)
        switch method {
        case "getInfo": return .getInfo
        case "reset": return .reset
        case "create":
            return .create(CreateOptions(
                protocolVersion: try args.number("protocolVersion"),
                skipBackSeconds: try args.number("skipBackSeconds"),
                skipForwardSeconds: try args.number("skipForwardSeconds")
            ))
        case "load": return .load(try decodeLoad(args))
        case "putAssets":
            let generation = try args.generation()
            return .putAssets(
                playerId: try args.string("playerId"),
                generation: generation,
                assets: try args.assets(generation)
            )
        case "putLive":
            let spec = try args.object("spec")
            return .putLive(
                playerId: try args.string("playerId"),
                generation: try args.generation(),
                uri: try args.string("uri"),
                spec: BridgeLiveSpec(
                    url: try spec.string("url"),
                    baseUrl: try spec.string("baseUrl"),
                    keyUri: try spec.optionalString("keyUri"),
                    keyHex: try spec.optionalKeyHex("keyHex"),
                    refreshSec: try spec.number("refreshSec")
                )
            )
        case "releaseAssets":
            return .releaseAssets(playerId: try args.string("playerId"), generation: try args.generation())
        case "reattach":
            return .reattach(playerId: try args.string("playerId"), loadId: try args.string("loadId"))
        case "play": return .play(playerId: try args.string("playerId"))
        case "pause": return .pause(playerId: try args.string("playerId"))
        case "seek":
            let position = try args.number("position")
            if position < 0 { throw args.invalid("position is not negative") }
            return .seek(
                playerId: try args.string("playerId"),
                position: position,
                exact: try args.optionalBool("exact") ?? false
            )
        case "setRate":
            let rate = try args.number("rate")
            if rate <= 0 { throw args.invalid("rate is positive") }
            return .setRate(playerId: try args.string("playerId"), rate: rate)
        case "setVariant":
            return .setVariant(playerId: try args.string("playerId"), id: try args.string("id"))
        case "setAudioTrack":
            return .setAudioTrack(playerId: try args.string("playerId"), id: try args.string("id"))
        case "warmChunks":
            // ChunkBoundary[][]: an array of schedules, each an array of boundaries.
            let schedules = try args.array("schedules")
            for (i, schedule) in schedules.enumerated() {
                guard case .array(let boundaries) = schedule else {
                    throw args.invalid("schedules[\(i)] is not an array")
                }
                for (j, boundary) in boundaries.enumerated() {
                    // Complete, or refused: a dropped boundary would merge its neighbours and warm
                    // the wrong chunk.
                    guard boundary.objectValue != nil else { throw args.invalid("schedules[\(i)][\(j)] is not an object") }
                    guard boundary["url"]?.stringValue != nil, boundary["start"]?.numberValue != nil,
                          boundary["end"]?.numberValue != nil else {
                        throw args.invalid("schedules[\(i)][\(j)] has no url, start and end")
                    }
                }
            }
            return .warmChunks(
                playerId: try args.string("playerId"),
                loadId: try args.string("loadId"),
                schedules: schedules,
                leadSeconds: try args.number("leadSeconds"),
                warmBytes: try args.count("warmBytes")
            )
        case "setInlineFrame":
            var frame: InlineFrame? = nil
            if let object = try args.optionalObject("frame") {
                let (width, height) = (try object.number("width"), try object.number("height"))
                guard width > 0, height > 0 else { throw args.invalid("frame has a positive width and height") }
                frame = InlineFrame(x: try object.number("x"), y: try object.number("y"), width: width, height: height)
            }
            return .setInlineFrame(playerId: try args.string("playerId"), frame: frame)
        case "enterFullscreen": return .enterFullscreen(playerId: try args.string("playerId"))
        case "exitFullscreen": return .exitFullscreen(playerId: try args.string("playerId"))
        case "resumed": return .resumed(playerId: try args.string("playerId"))
        case "destroy": return .destroy(playerId: try args.string("playerId"))
        default: throw BridgeRejection(.unsupported, "No bridge method \(method)")
        }
    }

    private static func decodeLoad(_ args: Args) throws -> LoadArgs {
        let generation = try args.generation()
        let recovery = try args.object("recovery")
        let nowPlaying = try args.optionalObject("nowPlaying")
        _ = try args.optionalObject("requestHeaders")
        let masterUri = try args.string("masterUri")
        let startPosition = try args.optionalNumber("startPosition")
        if let startPosition, startPosition < 0 { throw args.invalid("startPosition is not negative") }
        let delays = try recovery.array("reloadDelaysMs").enumerated().map { i, delay in
            guard let value = finiteNumber(delay) else {
                throw recovery.invalid("reloadDelaysMs[\(i)] is not a number")
            }
            return value
        }
        let load = LoadArgs(
            playerId: try args.string("playerId"),
            loadId: try args.string("loadId"),
            generation: generation,
            masterUri: masterUri,
            assets: try args.assets(generation),
            keyHex: try args.optionalKeyHex("keyHex"),
            startPosition: startPosition,
            recovery: RecoveryPolicy(
                escalationWindowMs: try recovery.number("escalationWindowMs"),
                maxReloadAttempts: try recovery.count("maxReloadAttempts"),
                reloadDelaysMs: delays
            ),
            nowPlaying: try nowPlaying.map {
                NowPlaying(
                    title: try $0.string("title"),
                    subtitle: try $0.optionalString("subtitle"),
                    artworkUrl: try $0.optionalString("artworkUrl")
                )
            }
        )
        if !masterUri.hasPrefix(assetUriPrefix) { throw args.invalid("masterUri is a luminary://asset/ address") }
        return load
    }
}

private func finiteNumber(_ value: JSON?) -> Double? {
    guard case .number(let number)? = value, number.isFinite else { return nil }
    return number
}

/// ASCII hex only: `Character.isHexDigit` also accepts the fullwidth digits, which decode to
/// nothing and would be served as a key of zeros.
public func isKeyHex(_ value: String) -> Bool {
    value.utf8.count == 32 && value.utf8.allSatisfy {
        ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66)
    }
}

/// Reads one JSON object's fields as `bridge.ts` declares them; any mismatch is `invalid-argument`.
private struct Args {
    let json: [String: JSON]
    let path: String

    init(_ json: [String: JSON], path: String) {
        self.json = json
        self.path = path
    }

    func invalid(_ message: String) -> BridgeRejection {
        BridgeRejection(.invalidArgument, "\(path): \(message)")
    }

    func string(_ key: String) throws -> String {
        guard let value = try optionalString(key) else { throw invalid("\(key) is required") }
        return value
    }

    func optionalString(_ key: String) throws -> String? {
        guard let value = json[key] else { return nil }
        guard case .string(let string) = value else { throw invalid("\(key) is not a string") }
        return string
    }

    func number(_ key: String) throws -> Double {
        guard let value = try optionalNumber(key) else { throw invalid("\(key) is required") }
        return value
    }

    func optionalNumber(_ key: String) throws -> Double? {
        guard let value = json[key] else { return nil }
        guard let number = finiteNumber(value) else { throw invalid("\(key) is not a finite number") }
        return number
    }

    func optionalBool(_ key: String) throws -> Bool? {
        guard let value = json[key] else { return nil }
        guard case .bool(let flag) = value else { throw invalid("\(key) is not a boolean") }
        return flag
    }

    func object(_ key: String) throws -> Args {
        guard let value = try optionalObject(key) else { throw invalid("\(key) is required") }
        return value
    }

    func optionalObject(_ key: String) throws -> Args? {
        guard let value = json[key] else { return nil }
        guard let object = value.objectValue else { throw invalid("\(key) is not an object") }
        return Args(object, path: "\(path).\(key)")
    }

    func array(_ key: String) throws -> [JSON] {
        guard case .array(let items)? = json[key] else { throw invalid("\(key) is not an array") }
        return items
    }

    func optionalKeyHex(_ key: String) throws -> String? {
        guard let value = try optionalString(key) else { return nil }
        if !isKeyHex(value) { throw invalid("\(key) is 32 hex characters") }
        return value
    }

    func generation() throws -> Int {
        try count("generation")
    }

    /// A non-negative integer that fits: `Int(Double)` traps past 2^63, and a count past
    /// `Int32.max` names nothing a player has.
    func count(_ key: String) throws -> Int {
        let value = try number(key)
        guard value >= 0, value.rounded() == value, value <= Double(Int32.max) else {
            throw invalid("\(key) is a non-negative integer")
        }
        return Int(value)
    }

    /// Every asset must be addressed to `generation`.
    func assets(_ generation: Int) throws -> [BridgeAsset] {
        let prefix = "\(assetUriPrefix)\(generation)/"
        return try array("assets").enumerated().map { i, element in
            guard let object = element.objectValue else { throw invalid("assets[\(i)] is not an object") }
            let asset = Args(object, path: "\(path).assets[\(i)]")
            let uri = try asset.string("uri")
            let bridgeAsset = BridgeAsset(
                uri: uri,
                contentType: try asset.string("contentType"),
                text: try asset.string("text")
            )
            if !uri.hasPrefix(prefix) { throw invalid("\(uri) is not an asset of generation \(generation)") }
            return bridgeAsset
        }
    }
}
