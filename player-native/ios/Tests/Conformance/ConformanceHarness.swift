/// The test seam plan 03 builds for the conformance runner: a `PlayerRegistry` wired to a
/// `FakeEngine` and a virtual clock. The Kotlin interface has the same members;
/// `conformance/README.md` describes each one.
public protocol ConformanceHarness: AnyObject {
    /// Starts a registry reporting these capabilities (every key present).
    func start(capabilities: [String: JSON])
    /// Goes through the same decoding and validation as `LuminaryPlayerPlugin`.
    func call(method: String, args: [String: JSON]) -> CallResult
    func engine(signal: String, args: [String: JSON])
    func advanceClock(seconds: Double)
    /// `{ "name", "payload" }` per event, in emission order, since the last drain.
    func drainEvents() -> [JSON]
    /// `{ "method", …args }` per engine call, since the last drain.
    func drainEngineCalls() -> [JSON]
    /// Through the `UriRouter` of the most recently created player, even once destroyed.
    func route(uri: String) -> RouteResult
}

public enum CallResult {
    /// A call that answers nothing resolves with `.object([:])`.
    case resolved(JSON)
    /// `code` is one of the bridge's rejection codes.
    case rejected(code: String, message: String)
}

public enum RouteResult {
    case served(bytes: [UInt8], contentType: String)
    /// `not-found` or `key-required`.
    case failed(code: String)

    /// The JSON a scenario's `route.expect` is matched against.
    var json: JSON {
        switch self {
        case .served(let bytes, let contentType):
            var view: [String: JSON] = [
                "contentType": .string(contentType),
                "bytes": .number(Double(bytes.count)),
                "hex": .string(bytes.map { String(format: "%02x", $0) }.joined()),
            ]
            if let text = String(bytes: bytes, encoding: .utf8) { view["text"] = .string(text) }
            return .object(view)
        case .failed(let code):
            return .object(["error": .string(code)])
        }
    }
}
