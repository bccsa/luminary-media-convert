import LuminaryPlayerCore

/// The harness the scenarios run against, fresh for each one.
func makeConformanceHarness() -> ConformanceHarness? {
    RegistryHarness()
}

/// The real ``PlayerRegistry`` on a ``FakeEngine`` and a ``VirtualClock``.
private final class RegistryHarness: ConformanceHarness {
    private let clock = VirtualClock()
    private var events: [JSON] = []
    private var engineCalls: [JSON] = []
    private var engines: [ObjectIdentifier: FakeEngine] = [:]
    private var registry: PlayerRegistry?

    func start(capabilities: [String: JSON]) {
        registry = PlayerRegistry(
            capabilities: BridgeCapabilities(json: capabilities),
            clock: clock,
            engineFactory: { [unowned self] router, clock, _ in
                let engine = FakeEngine(clock: clock) { [unowned self] call in engineCalls.append(call) }
                engines[ObjectIdentifier(router)] = engine
                return engine
            },
            emit: { [unowned self] name, payload in
                events.append(.object(["name": .string(name), "payload": .object(payload)]))
            }
        )
    }

    func call(method: String, args: [String: JSON]) -> CallResult {
        do {
            return .resolved(try started().call(method, args))
        } catch let rejection as BridgeRejection {
            return .rejected(code: rejection.code.rawValue, message: rejection.message)
        } catch {
            return .rejected(code: BridgeErrorCode.engine.rawValue, message: "\(error)")
        }
    }

    func engine(signal: String, args: [String: JSON]) {
        guard let player = started().current, let engine = engines[ObjectIdentifier(player.router)] else {
            preconditionFailure("No engine: create a player first")
        }
        engine.signal(signal, args)
    }

    func advanceClock(seconds: Double) {
        clock.advance(seconds)
    }

    func drainEvents() -> [JSON] {
        defer { events.removeAll() }
        return events
    }

    func drainEngineCalls() -> [JSON] {
        defer { engineCalls.removeAll() }
        return engineCalls
    }

    func route(uri: String) -> RouteResult {
        guard let player = started().current else { return .failed(code: "not-found") }
        switch player.router.route(uri) {
        case .served(let bytes, let contentType): return .served(bytes: bytes, contentType: contentType)
        case .failed(let code): return .failed(code: code)
        case .live, .unanswered:
            // A route result has no shape for these yet; it arrives with the phase 4 scenarios.
            preconditionFailure("no conformance scenario routes \(uri)")
        }
    }

    private func started() -> PlayerRegistry {
        guard let registry else { preconditionFailure("start the harness first") }
        return registry
    }
}
