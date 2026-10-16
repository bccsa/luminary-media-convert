import Foundation
import Testing
import LuminaryPlayerCore

/// Answers from the reference native side's recorded conversation
/// (`conformance/selftest/transcripts/`), and records a mismatch the moment this runner
/// drives the harness differently from the TypeScript one.
private final class TranscriptHarness: ConformanceHarness {
    private let ops: [JSON]
    private var cursor = 0
    private(set) var mismatch: String?

    init(ops: [JSON]) {
        self.ops = ops
    }

    var finished: Bool { cursor == ops.count }

    private func next(_ op: String, _ inputs: [String: JSON]) -> JSON? {
        guard mismatch == nil else { return nil }
        guard cursor < ops.count else {
            mismatch = "op \(cursor): \(op) \(JSON.object(inputs)), but the transcript has ended"
            return nil
        }
        let recorded = ops[cursor]
        let expected = JSON.object(inputs.merging(["op": .string(op)]) { $1 })
        let matches = recorded["op"] == .string(op) && inputs.allSatisfy { recorded[$0.key] == $0.value }
        guard matches else {
            mismatch = "op \(cursor): this runner sent \(expected), the TypeScript runner sent \(recorded)"
            return nil
        }
        cursor += 1
        return recorded
    }

    func start(capabilities: [String: JSON]) {
        _ = next("start", ["capabilities": .object(capabilities)])
    }

    func call(method: String, args: [String: JSON]) -> CallResult {
        guard let result = next("call", ["method": .string(method), "args": .object(args)])?["result"] else {
            return .resolved(.object([:]))
        }
        if let rejected = result["rejected"] {
            return .rejected(code: rejected["code"]?.stringValue ?? "", message: rejected["message"]?.stringValue ?? "")
        }
        return .resolved(result["resolved"] ?? .object([:]))
    }

    func engine(signal: String, args: [String: JSON]) {
        _ = next("engine", ["signal": .string(signal), "args": .object(args)])
    }

    func advanceClock(seconds: Double) {
        _ = next("advanceClock", ["seconds": .number(seconds)])
    }

    func drainEvents() -> [JSON] {
        guard case .array(let events)? = next("drainEvents", [:])?["events"] else { return [] }
        return events
    }

    func drainEngineCalls() -> [JSON] {
        guard case .array(let calls)? = next("drainEngineCalls", [:])?["calls"] else { return [] }
        return calls
    }

    func route(uri: String) -> RouteResult {
        guard let result = next("route", ["uri": .string(uri)])?["result"] else { return .failed(code: "not-found") }
        if let served = result["served"] {
            let hex = Array(served["hex"]?.stringValue ?? "")
            let bytes = stride(from: 0, to: hex.count, by: 2).map { UInt8(String(hex[$0...$0 + 1]), radix: 16)! }
            return .served(bytes: bytes, contentType: served["contentType"]?.stringValue ?? "")
        }
        return .failed(code: result["failed"]?.stringValue ?? "")
    }
}

private let scenarioFiles = (try? ScenarioRunner.loadScenarios()) ?? []

@Suite("Conformance runner parity")
struct TranscriptTests {
    /// Every scenario, replayed against the reference side's transcript: this runner must
    /// drive a harness exactly as the TypeScript runner does, and accept what it accepted.
    @Test("replays the reference transcript", arguments: scenarioFiles)
    func replays(_ file: ScenarioRunner.ScenarioFile) throws {
        let url = ScenarioRunner.conformanceDirectory.appendingPathComponent("selftest/transcripts/\(file.file)")
        guard case .array(let ops)? = try JSON.parse(Data(contentsOf: url))["ops"] else {
            Issue.record("\(file.file): no transcript")
            return
        }
        let harness = TranscriptHarness(ops: ops)
        var failure: String?
        do {
            try ScenarioRunner.run(file.scenario, on: harness)
        } catch let error as MatchError {
            failure = error.description
        }
        if let mismatch = harness.mismatch {
            Issue.record("\(file.file): \(mismatch)")
        } else if let failure {
            Issue.record("\(file.file): \(failure)")
        } else if !harness.finished {
            Issue.record("\(file.file): the TypeScript runner went further through the transcript")
        }
    }
}
