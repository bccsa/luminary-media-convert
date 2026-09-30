import AVFoundation
import AVKit
import LuminaryPlayerCore

/// Phase 1b on the device: the real `PlayerRegistry` → `PlayerHost` → `UriRouter` →
/// `AVPlayerEngine`, driven through `PlayerRegistry.call` with the calls JavaScript sends, and
/// every event it emits logged. Launched with `-engine`.
@MainActor
final class EngineRun {
    private let payload: Payload
    private let view: AVPlayerViewController
    private let log: (String) -> Void
    private let clock = MainQueueClock()
    private var registry: PlayerRegistry!
    private var engine: AVPlayerEngine?
    private var playerId = ""
    private var started = Date()
    private var events: [(name: String, payload: [String: JSON], at: Double)] = []

    init(payload: Payload, view: AVPlayerViewController, log: @escaping (String) -> Void) {
        self.payload = payload
        self.view = view
        self.log = log
    }

    func run() async {
        var capabilities = BridgeCapabilities()
        capabilities.pictureInPicture = true
        registry = PlayerRegistry(
            capabilities: capabilities,
            clock: clock,
            engineFactory: { [weak self] router, clock, options in
                let engine = AVPlayerEngine(router: router, clock: clock, options: options, presenter: nil)
                self?.engine = engine
                self?.view.player = engine.player
                return engine
            },
            emit: { [weak self] name, payload in self?.received(name, payload) }
        )

        log("engine  start")
        call("getInfo", [:])
        call("reset", [:])
        let created = call("create", ["protocolVersion": .number(1), "skipBackSeconds": .number(10), "skipForwardSeconds": .number(10)])
        playerId = created?["playerId"]?.stringValue ?? ""
        let player: [String: JSON] = ["playerId": .string(playerId)]

        // First load and play.
        let first = payload.visits[0]
        started = Date()
        load(first, loadId: "load-1", at: nil)
        call("play", player)
        await expect("playing", within: 20)
        await wait(4)
        let timeupdates = events.filter { $0.name == "timeupdate" }.count
        log("check   timeupdates in the first 4 s of playing: \(timeupdates)")

        // An audio switch to the second track the engine listed.
        if let tracks = events.last(where: { $0.name == "audiotracks-updated" && !(($0.payload["tracks"]).map(isEmptyArray) ?? true) })?.payload["tracks"],
           case .array(let list) = tracks, list.count > 1, let id = list[1]["id"]?.stringValue {
            call("setAudioTrack", player.merging(["id": .string(id)]) { $1 })
            await expect("audiotracks-updated", within: 5)
        }

        // An angle switch: the next visit in the same generation, at the current position.
        if payload.visits.count > 1 {
            let position = engine?.snapshot().currentTime ?? 0
            started = Date()
            load(payload.visits[1], loadId: "load-2", at: position)
            call("play", player)
            await expect("playing", within: 20)
            await wait(3)
        }

        // Seek, pause, resume snapshot, destroy.
        call("seek", player.merging(["position": .number(600)]) { $1 })
        await expect("seeked", within: 10)
        call("pause", player)
        await expect("pause", within: 5)
        let resumed = call("resumed", player)
        log("check   resumed → \(resumed?.description ?? "nil")")
        let beforeDestroy = events.count
        call("destroy", player)
        await wait(1)
        let afterDestroy = events.count - beforeDestroy
        log("check   events in the second after destroy: \(afterDestroy)")
        log("engine  done")
    }

    // MARK: Calls

    private func load(_ visit: Payload.Visit, loadId: String, at position: Double?) {
        var args: [String: JSON] = [
            "playerId": .string(playerId),
            "loadId": .string(loadId),
            "generation": .number(Double(visit.generation)),
            "masterUri": .string(visit.masterUri),
            "assets": .array(visit.assets.map {
                .object(["uri": .string($0.uri), "contentType": .string($0.contentType), "text": .string($0.text)])
            }),
            "recovery": .object([
                "escalationWindowMs": .number(10_000),
                "maxReloadAttempts": .number(3),
                "reloadDelaysMs": .array([.number(2_000), .number(4_000), .number(8_000)]),
            ]),
        ]
        if let key = payload.keyHex { args["keyHex"] = .string(key) }
        if let position { args["startPosition"] = .number(position) }
        call("load", args)
    }

    @discardableResult
    private func call(_ method: String, _ args: [String: JSON]) -> JSON? {
        do {
            let result = try registry.call(method, args)
            log("call    \(method) → ok")
            return result
        } catch let rejection as BridgeRejection {
            log("call    \(method) → REJECTED \(rejection.code.rawValue): \(rejection.message)")
        } catch {
            log("call    \(method) → ERROR \(error)")
        }
        return nil
    }

    // MARK: Events

    private func received(_ name: String, _ payload: [String: JSON]) {
        let at = Date().timeIntervalSince(started)
        events.append((name, payload, at))
        var shown = payload
        shown["playerId"] = nil
        if name == "audiotracks-updated", case .array(let tracks)? = payload["tracks"] {
            shown["tracks"] = .string("\(tracks.count) tracks: " + tracks.compactMap { $0["id"]?.stringValue }.joined(separator: ", "))
        }
        if name != "timeupdate" {
            log(String(format: "event   %6.0f ms  %@ %@", at * 1000, name, JSON.object(shown).description))
        }
    }

    private func expect(_ name: String, within seconds: Double) async {
        let from = events.count
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if events[from...].contains(where: { $0.name == name }) { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        log("check   NO \(name) within \(Int(seconds)) s")
    }

    private func wait(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func isEmptyArray(_ value: JSON) -> Bool {
        if case .array(let items) = value { return items.isEmpty }
        return true
    }
}

/// The app's clock: monotonic seconds, timers on the main queue.
final class MainQueueClock: Clock {
    private final class Timer: Cancellable {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }

    func now() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
    }

    func schedule(_ delaySeconds: Double, _ run: @escaping () -> Void) -> Cancellable {
        nonisolated(unsafe) let run = run
        let item = DispatchWorkItem { run() }
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds, execute: item)
        return Timer(item)
    }
}
