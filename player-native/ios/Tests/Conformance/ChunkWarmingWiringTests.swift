import Foundation
import Testing
import LuminaryPlayerCore

/// How `warmChunks` reaches a player's ``ChunkWarmer``: only for the current load, stopped by the
/// next load and by destroy. The loop itself is pinned in the core's `ChunkWarmerTests`.
@Suite("Chunk warming, wired to the player")
struct ChunkWarmingWiringTests {
    private final class Run {
        let clock = VirtualClock()
        var warmed: [String] = []
        var registry: PlayerRegistry!
        var playerId = ""

        init() {
            var capabilities = BridgeCapabilities()
            capabilities.chunkWarming = true
            registry = PlayerRegistry(
                capabilities: capabilities,
                clock: clock,
                engineFactory: { _, clock, _ in FakeEngine(clock: clock) { _ in } },
                emit: { _, _ in },
                warmFetch: { [unowned self] url, _ in self.warmed.append(url.absoluteString) }
            )
            let created = try! registry.call("create", [
                "protocolVersion": .number(Double(protocolVersion)),
                "skipBackSeconds": .number(10), "skipForwardSeconds": .number(10),
            ])
            playerId = created["playerId"]!.stringValue!
        }

        func load(_ loadId: String, generation: Int) {
            _ = try! registry.call("load", [
                "playerId": .string(playerId), "loadId": .string(loadId), "generation": .number(Double(generation)),
                "masterUri": .string("luminary://asset/\(generation)/1.m3u8"),
                "assets": .array([.object([
                    "uri": .string("luminary://asset/\(generation)/1.m3u8"),
                    "contentType": .string("application/vnd.apple.mpegurl"),
                    "text": .string("#EXTM3U\n"),
                ])]),
                "recovery": .object([
                    "escalationWindowMs": .number(10_000), "maxReloadAttempts": .number(3),
                    "reloadDelaysMs": .array([.number(2000), .number(4000), .number(8000)]),
                ]),
            ])
        }

        /// A chain whose second chunk is within a 60 s lead from position 0: warmed on the first tick.
        func warm(_ loadId: String) {
            let boundary = { (url: String, start: Double) -> JSON in
                .object(["url": .string(url), "start": .number(start), "end": .number(start + 20)])
            }
            _ = try! registry.call("warmChunks", [
                "playerId": .string(playerId), "loadId": .string(loadId),
                "schedules": .array([.array([boundary("https://cdn.test/v_0.m4s", 0), boundary("https://cdn.test/v_1.m4s", 20)])]),
                "leadSeconds": .number(60), "warmBytes": .number(65_536),
            ])
        }
    }

    @Test("warms for the current load")
    func current() {
        let run = Run()
        run.load("load-1", generation: 1)
        run.warm("load-1")
        run.clock.advance(1)
        #expect(run.warmed == ["https://cdn.test/v_1.m4s"])
    }

    @Test("ignores a call for a load that has been replaced")
    func stale() {
        let run = Run()
        run.load("load-1", generation: 1)
        run.load("load-2", generation: 2)
        run.warm("load-1")
        run.clock.advance(5)
        #expect(run.warmed.isEmpty)
    }

    @Test("a new load stops the warming of the one it replaces")
    func newLoadStops() {
        let run = Run()
        run.load("load-1", generation: 1)
        run.warm("load-1")
        run.load("load-2", generation: 2)
        run.clock.advance(5)
        #expect(run.warmed.isEmpty)
    }

    @Test("destroy stops it")
    func destroyStops() {
        let run = Run()
        run.load("load-1", generation: 1)
        run.warm("load-1")
        _ = try! run.registry.call("destroy", ["playerId": .string(run.playerId)])
        run.clock.advance(5)
        #expect(run.warmed.isEmpty)
    }

    @Test("refused while the capability is off")
    func refused() {
        let registry = PlayerRegistry(
            capabilities: BridgeCapabilities(), clock: VirtualClock(),
            engineFactory: { _, clock, _ in FakeEngine(clock: clock) { _ in } }, emit: { _, _ in }
        )
        #expect(throws: BridgeRejection.self) {
            try registry.call("warmChunks", ["playerId": .string("player-1")])
        }
    }
}
