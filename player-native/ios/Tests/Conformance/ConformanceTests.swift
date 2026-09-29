import Foundation
import Testing

private let scenarioFiles = (try? ScenarioRunner.loadScenarios()) ?? []

@Suite("Conformance")
struct ConformanceTests {
    @Test("the shared scenario files load and validate")
    func scenariosLoad() throws {
        let files = try ScenarioRunner.loadScenarios()
        #expect(!files.isEmpty)
    }

    @Test("refs and matchers pass the shared cases")
    func matchCases() throws {
        let url = ScenarioRunner.conformanceDirectory.appendingPathComponent("selftest/match-cases.json")
        guard case .array(let cases)? = try JSON.parse(Data(contentsOf: url))["cases"] else {
            Issue.record("match-cases.json has no cases")
            return
        }
        for testCase in cases {
            let name = testCase["name"]?.stringValue ?? "?"
            guard case .array(let ops)? = testCase["ops"] else { continue }
            let refs = Refs()
            for op in ops {
                if let assert = op["assert"] {
                    let ok = op["ok"] == .bool(true)
                    do {
                        try refs.assert(assert["actual"], assert["expected"]!)
                        #expect(ok, "\(name): matched, expected a mismatch")
                    } catch let error as MatchError {
                        #expect(!ok, "\(name): \(error.description)")
                    }
                } else if let value = op["issue"] {
                    let issued = try? refs.issue(value)
                    if op["error"] == .bool(true) {
                        #expect(issued == nil, "\(name): issued \(issued.map(\.description) ?? "")")
                    } else {
                        #expect(issued == op["result"], "\(name): issued \(issued.map(\.description) ?? "nothing")")
                    }
                }
            }
        }
    }

    /// Without a harness every scenario fails rather than skips: the platform does not
    /// conform until it runs them.
    @Test("scenario", arguments: scenarioFiles)
    func scenario(_ file: ScenarioRunner.ScenarioFile) throws {
        guard let harness = makeConformanceHarness() else {
            Issue.record("No ConformanceHarness: build plan 03's phase 1a (PlayerRegistry on a FakeEngine)")
            return
        }
        do {
            try ScenarioRunner.run(file.scenario, on: harness)
        } catch let error as MatchError {
            Issue.record("\(file.file): \(error.description)")
        }
    }
}
