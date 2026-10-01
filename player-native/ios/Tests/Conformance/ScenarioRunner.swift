import Foundation
import LuminaryPlayerCore

/// The native side of a conformance scenario, replayed against a ``ConformanceHarness``.
/// Mirrors `src/test-support/conformance/{load,tsRunner}.ts`; `conformance/README.md` is normative.
public enum ScenarioRunner {
    /// `player-native/conformance`, found from this file; `LUMINARY_CONFORMANCE_DIR` overrides it.
    public static var conformanceDirectory: URL {
        if let override = ProcessInfo.processInfo.environment["LUMINARY_CONFORMANCE_DIR"] {
            return URL(fileURLWithPath: override)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Conformance
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // player-native
            .appendingPathComponent("conformance")
    }

    public struct ScenarioFile: CustomStringConvertible, Sendable {
        public let file: String
        public let scenario: JSON
        public var description: String { file }
    }

    /// Every `conformance/*.json`, validated; throws naming the first file that is not a scenario.
    public static func loadScenarios(from directory: URL = conformanceDirectory) throws -> [ScenarioFile] {
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".json") }
            .sorted()
        return try files.map { file in
            let scenario = try JSON.parse(Data(contentsOf: directory.appendingPathComponent(file)))
            do {
                try validate(scenario)
            } catch let error as MatchError {
                throw MatchError("\(file): \(error.description)")
            }
            return ScenarioFile(file: file, scenario: scenario)
        }
    }

    public static let defaultCapabilities: [String: JSON] = [
        "variantSwitching": .bool(false),
        "pictureInPicture": .bool(false),
        "renderText": .bool(false),
        "live": .bool(false),
        "chunkWarming": .bool(false),
        "backgroundAudio": .bool(false),
        "maxPlayers": .number(1),
    ]

    /// Runs every native step; throws a ``MatchError`` naming the first that fails.
    public static func run(_ scenario: JSON, on harness: ConformanceHarness) throws {
        var capabilities = defaultCapabilities
        for (key, value) in scenario["capabilities"]?.objectValue ?? [:] { capabilities[key] = value }
        harness.start(capabilities: capabilities)

        let run = NativeRun(harness: harness)
        guard case .array(let steps)? = scenario["steps"] else { throw MatchError("steps is required") }
        for (index, step) in steps.enumerated() {
            guard let object = step.objectValue, try appliesToNative(object) else { continue }
            let kind = try stepKind(object)
            do {
                try run.step(kind, object[kind]!)
            } catch let error as MatchError {
                throw MatchError("step \(index) (\(kind)): \(error.description)")
            }
        }
        do {
            try run.expectNoEvents()
        } catch let error as MatchError {
            throw MatchError("end of scenario: \(error.description)")
        }
    }
}

// MARK: - The format

private let stepSides: [String: Set<String>] = [
    "drive": ["ts"],
    "call": ["ts", "native"],
    "event": ["ts", "native"],
    "engine": ["native"],
    "advanceClock": ["ts", "native"],
    "expectNoEvents": ["native"],
    "expectEngine": ["native"],
    "expectAdapter": ["ts"],
    "expectState": ["ts"],
    "expectNoCalls": ["ts"],
    "route": ["native"],
]

private let stepKeys: [String: Set<String>] = [
    "drive": ["start", "controller", "adapter", "args", "rejects"],
    "call": ["method", "args", "match", "result", "rejects"],
    "event": ["name", "payload"],
    "route": ["uri", "expect"],
]

private let topLevelKeys: Set<String> = ["$schema", "name", "description", "capabilities", "fetch", "steps"]

private let bridgeErrorCodes: Set<String> = [
    "unsupported", "unknown-player", "stale-generation", "invalid-argument", "protocol-mismatch", "engine",
]

/// The `FakeEngine` vocabulary; adding a signal is a change to the format.
public let engineSignals: Set<String> = [
    "readyToPlay", "playing", "paused", "buffering", "seeked", "ended",
    "tracks", "variants", "failed", "bufferedTo", "position", "rate",
]

private func stepKind(_ step: [String: JSON]) throws -> String {
    let kinds = step.keys.filter { $0 != "only" && $0 != "note" }
    guard kinds.count == 1, let kind = kinds.first, stepSides[kind] != nil else {
        throw MatchError("a step names exactly one kind; got \(step.keys.sorted())")
    }
    return kind
}

private func appliesToNative(_ step: [String: JSON]) throws -> Bool {
    let kind = try stepKind(step)
    guard let only = step["only"] else { return stepSides[kind]!.contains("native") }
    guard let side = only.stringValue, stepSides[kind]!.contains(side) else {
        throw MatchError("a \(kind) step cannot be restricted to \(only)")
    }
    return side == "native"
}

private func validate(_ scenario: JSON) throws {
    guard let object = scenario.objectValue else { throw MatchError("a scenario is an object") }
    if let unknown = object.keys.first(where: { !topLevelKeys.contains($0) }) {
        throw MatchError("scenario: unknown key \(unknown)")
    }
    guard let name = object["name"]?.stringValue, !name.isEmpty else { throw MatchError("name is required") }
    if let capabilities = object["capabilities"] {
        guard let keys = capabilities.objectValue?.keys else { throw MatchError("capabilities is an object") }
        if let unknown = keys.first(where: { ScenarioRunner.defaultCapabilities[$0] == nil }) {
            throw MatchError("capabilities: unknown key \(unknown)")
        }
    }
    guard case .array(let steps)? = object["steps"], !steps.isEmpty else {
        throw MatchError("steps is a non-empty array")
    }
    for (index, step) in steps.enumerated() {
        let where_ = "step \(index)"
        guard let body = step.objectValue else { throw MatchError("\(where_): a step is an object") }
        let kind = try stepKind(body)
        _ = try appliesToNative(body)
        let value = body[kind]!
        if let allowed = stepKeys[kind] {
            guard let keys = value.objectValue?.keys else { throw MatchError("\(where_): \(kind) takes an object") }
            if let unknown = keys.first(where: { !allowed.contains($0) }) {
                throw MatchError("\(where_) (\(kind)): unknown key \(unknown)")
            }
        }
        if let rejects = value["rejects"], !bridgeErrorCodes.contains(rejects.stringValue ?? "") {
            throw MatchError("\(where_): \(rejects) is not a bridge error code")
        }
        switch kind {
        case "call":
            guard value["method"]?.stringValue != nil else { throw MatchError("\(where_): call.method is required") }
            if value["result"] != nil, value["rejects"] != nil {
                throw MatchError("\(where_): result or rejects, not both")
            }
        case "event":
            guard value["name"]?.stringValue != nil, value["payload"]?.objectValue != nil else {
                throw MatchError("\(where_): event takes a name and a payload object")
            }
        case "engine":
            guard let signal = value["signal"]?.stringValue else {
                throw MatchError("\(where_): engine takes { signal, ...args }")
            }
            guard engineSignals.contains(signal) else { throw MatchError("\(where_): unknown engine signal \(signal)") }
        case "advanceClock":
            guard let seconds = value.numberValue, seconds > 0 else {
                throw MatchError("\(where_): advanceClock takes seconds > 0")
            }
        case "expectNoEvents", "expectNoCalls":
            guard value == .bool(true) else { throw MatchError("\(where_): \(kind) takes true") }
        case "expectAdapter", "expectState":
            guard value.objectValue != nil else { throw MatchError("\(where_): \(kind) takes an object") }
        case "route":
            guard value["uri"]?.stringValue != nil, value["expect"] != nil else {
                throw MatchError("\(where_): route takes a uri and an expect")
            }
        default:
            break
        }
    }
}

// MARK: - Replaying

private final class NativeRun {
    private let harness: ConformanceHarness
    private let refs = Refs()
    private var pending: [JSON] = []

    init(harness: ConformanceHarness) {
        self.harness = harness
    }

    func step(_ kind: String, _ body: JSON) throws {
        switch kind {
        case "call": try call(body)
        case "event": try event(body)
        case "engine":
            var args = body.objectValue ?? [:]
            let signal = args.removeValue(forKey: "signal")?.stringValue ?? ""
            harness.engine(signal: signal, args: try refs.issue(.object(args)).objectValue ?? [:])
        case "advanceClock":
            harness.advanceClock(seconds: body.numberValue ?? 0)
        case "expectNoEvents":
            try expectNoEvents()
        case "expectEngine":
            try refs.assert(.array(harness.drainEngineCalls()), body, "engine")
        case "route":
            let uri = body["uri"]?.stringValue ?? ""
            try refs.assert(harness.route(uri: uri).json, body["expect"]!, "route(\(uri))")
        default:
            throw MatchError("\(kind) has no native side")
        }
    }

    private func call(_ body: JSON) throws {
        let method = body["method"]?.stringValue ?? ""
        let args = try refs.issue(body["args"] ?? .object([:])).objectValue ?? [:]
        switch harness.call(method: method, args: args) {
        case .resolved(let value):
            if let rejects = body["rejects"] {
                throw MatchError("\(method): expected a \(rejects) rejection, got \(value)")
            }
            if let result = body["result"] { try refs.assert(value, result, "\(method).result") }
        case .rejected(let code, let message):
            guard let rejects = body["rejects"] else {
                throw MatchError("\(method): rejected \(code) (\(message))")
            }
            if rejects != .string(code) { throw MatchError("\(method): expected a \(rejects) rejection, got \(code)") }
        }
    }

    private func event(_ body: JSON) throws {
        if pending.isEmpty { pending = harness.drainEvents() }
        let name = body["name"]?.stringValue ?? ""
        guard !pending.isEmpty else { throw MatchError("expected a \(name) event; none was emitted") }
        let emitted = pending.removeFirst()
        guard emitted["name"] == .string(name) else {
            throw MatchError("expected a \(name) event, got \(emitted["name"].map(\.description) ?? "an unnamed one")")
        }
        try refs.assert(emitted["payload"], body["payload"]!, "\(name).payload")
    }

    func expectNoEvents() throws {
        pending += harness.drainEvents()
        guard pending.isEmpty else {
            throw MatchError("unasserted events: \(pending.compactMap { $0["name"]?.stringValue }.joined(separator: ", "))")
        }
    }
}
