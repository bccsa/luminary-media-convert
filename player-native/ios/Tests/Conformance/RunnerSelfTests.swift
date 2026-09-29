import Testing

/// A harness that answers from a script, for pinning the runner itself: a runner that
/// passes everything proves nothing.
private final class ScriptedHarness: ConformanceHarness {
    var events: [JSON] = []
    var answers: [String: CallResult] = [:]
    var engineCalls: [JSON] = []
    private(set) var signals: [String] = []

    func start(capabilities: [String: JSON]) {}
    func call(method: String, args: [String: JSON]) -> CallResult { answers[method] ?? .resolved(.object([:])) }
    func engine(signal: String, args: [String: JSON]) { signals.append(signal) }
    func advanceClock(seconds: Double) {}
    func drainEvents() -> [JSON] { defer { events = [] }; return events }
    func drainEngineCalls() -> [JSON] { defer { engineCalls = [] }; return engineCalls }
    func route(uri: String) -> RouteResult { .failed(code: "not-found") }
}

private func event(_ name: String, _ payload: [String: JSON]) -> JSON {
    .object(["name": .string(name), "payload": .object(payload)])
}

private func scenario(_ steps: [JSON]) -> JSON {
    .object(["name": .string("self-test"), "steps": .array(steps)])
}

private let createStep: JSON = .object(["call": .object([
    "method": .string("create"),
    "result": .object(["playerId": .string("$player")]),
])])

@Suite("Conformance runner")
struct RunnerSelfTests {
    @Test("passes a conversation that matches")
    func passes() throws {
        let harness = ScriptedHarness()
        harness.answers["create"] = .resolved(.object(["playerId": .string("p-1")]))
        harness.events = [event("playing", ["playerId": .string("p-1"), "loadId": .string("l")])]
        try ScenarioRunner.run(scenario([
            createStep,
            .object(["event": .object([
                "name": .string("playing"),
                "payload": .object(["playerId": .string("$player")]),
            ])]),
            .object(["engine": .object(["signal": .string("playing")]), "note": .string("native")]),
            .object(["drive": .object(["start": .object([:])]), "note": .string("TS only: skipped")]),
        ]), on: harness)
        #expect(harness.signals == ["playing"])
    }

    @Test("fails on an event left unasserted")
    func leftoverEvent() {
        let harness = ScriptedHarness()
        harness.events = [event("pause", [:])]
        #expect(throws: MatchError.self) {
            try ScenarioRunner.run(scenario([.object(["advanceClock": .number(1)])]), on: harness)
        }
    }

    @Test("fails on a payload stamped with another player")
    func wrongRef() {
        let harness = ScriptedHarness()
        harness.answers["create"] = .resolved(.object(["playerId": .string("p-1")]))
        harness.events = [event("playing", ["playerId": .string("p-2")])]
        #expect(throws: MatchError.self) {
            try ScenarioRunner.run(scenario([
                createStep,
                .object(["event": .object([
                    "name": .string("playing"),
                    "payload": .object(["playerId": .string("$player")]),
                ])]),
            ]), on: harness)
        }
    }

    @Test("fails when a call resolves that should reject")
    func missingRejection() {
        #expect(throws: MatchError.self) {
            try ScenarioRunner.run(scenario([
                .object(["call": .object(["method": .string("play"), "rejects": .string("unknown-player")])]),
            ]), on: ScriptedHarness())
        }
    }

    @Test("fails on a route that answers differently")
    func wrongRoute() {
        #expect(throws: MatchError.self) {
            try ScenarioRunner.run(scenario([
                .object(["route": .object([
                    "uri": .string("luminary://key"),
                    "expect": .object(["bytes": .number(16)]),
                ])]),
            ]), on: ScriptedHarness())
        }
    }
}
