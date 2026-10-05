import Testing
import LuminaryPlayerCore

/// Arguments a call rejects as `invalid-argument` rather than trapping on: the bridge promises a
/// refused call changes nothing, and a crash changes everything.
@Suite("Bridge arguments")
struct BridgeTypesTests {
    private func load(maxReloadAttempts: JSON) -> [String: JSON] {
        [
            "playerId": .string("player-1"),
            "loadId": .string("load-1"),
            "generation": .number(0),
            "masterUri": .string("luminary://asset/0/master.m3u8"),
            "assets": .array([]),
            "recovery": .object([
                "escalationWindowMs": .number(10_000),
                "maxReloadAttempts": maxReloadAttempts,
                "reloadDelaysMs": .array([.number(2_000)]),
            ]),
        ]
    }

    private func warm(warmBytes: JSON) -> [String: JSON] {
        [
            "playerId": .string("player-1"),
            "loadId": .string("load-1"),
            "schedules": .array([]),
            "leadSeconds": .number(60),
            "warmBytes": warmBytes,
        ]
    }

    private func rejection(_ method: String, _ args: [String: JSON]) -> BridgeErrorCode? {
        do {
            _ = try BridgeCall.decode(method, args)
            return nil
        } catch let rejection as BridgeRejection {
            return rejection.code
        } catch {
            return nil
        }
    }

    @Test("a reload count or a byte count past what fits is refused, not trapped on")
    func countsAreBounded() {
        for huge: JSON in [.number(1e19), .number(-1), .number(2.5), .number(Double(Int32.max) + 1)] {
            #expect(rejection("load", load(maxReloadAttempts: huge)) == .invalidArgument)
            #expect(rejection("warmChunks", warm(warmBytes: huge)) == .invalidArgument)
        }
    }

    @Test("counts that fit decode as they are")
    func countsDecode() throws {
        guard case .load(let args) = try BridgeCall.decode("load", load(maxReloadAttempts: .number(3))) else {
            Issue.record("not a load")
            return
        }
        #expect(args.recovery.maxReloadAttempts == 3)
        guard case .warmChunks(_, _, _, _, let bytes) = try BridgeCall.decode("warmChunks", warm(warmBytes: .number(65_536))) else {
            Issue.record("not a warmChunks")
            return
        }
        #expect(bytes == 65_536)
    }
}
