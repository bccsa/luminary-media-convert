import AVFoundation
import AVKit
import Combine

/// One `AVPlayer`, fed the bridge's payload the way `PlayerHost` will be:
/// assets into the store, the key into memory, then `AVURLAsset(masterUri)`
/// with the loader as its resource-loader delegate.
@MainActor
final class PlayerModel: ObservableObject {
    @Published private(set) var lines: [String] = []
    @Published var mode: AssetLoader.TypeMode = .uti
    /// True while `-autorun` drives the player; the buttons stand down.
    @Published private(set) var autorunning = false

    let player = AVPlayer()
    let controller = AVPlayerViewController()
    let payload: Payload?

    private var loader = AssetLoader()
    private var observers: [NSKeyValueObservation] = []
    private var notes: [NSObjectProtocol] = []
    private var loadStarted = Date()
    /// Attached to each new item, so a decoded frame is known to be the
    /// new item's, not one the previous item left on screen.
    private var videoOutput: AVPlayerItemVideoOutput?

    init() {
        controller.player = player
        do {
            payload = try Payload.bundled()
        } catch {
            payload = nil
            log("payload: \(error.localizedDescription)")
        }
        if let payload {
            log("payload: \(payload.visits.count) visits of \(payload.masterUrl)")
        }
    }

    nonisolated func log(_ line: String) {
        let stamped = "[spike] \(line)"
        print(stamped)
        Task { @MainActor in self.lines.append(stamped) }
    }

    // MARK: - Loading

    /// Everything a new generation needs: a fresh store and the key.
    func reset() {
        loader = AssetLoader()
        loader.mode = mode
        loader.log = { [weak self] in self?.log($0) }
        loader.setKey(hex: payload?.keyHex)
    }

    /// Plays one visit: its assets join the store (as `load` does within a
    /// generation), then the engine gets a new item for its master.
    func play(_ visit: Payload.Visit, at position: CMTime = .zero) {
        guard let payload, let url = URL(string: visit.masterUri) else { return }
        loader.put(visit.assets)

        let asset = AVURLAsset(url: url)
        asset.resourceLoader.setDelegate(loader, queue: loader.queue)
        let item = AVPlayerItem(asset: asset)
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
        item.add(output)
        videoOutput = output
        watch(item)

        loadStarted = Date()
        log("load    \(payload.name(of: visit)) mode=\(mode.rawValue) assets=+\(visit.assets.count)")
        player.replaceCurrentItem(with: item)
        if position > .zero {
            player.seek(to: position, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        player.play()
    }

    /// Milliseconds from `play` to the current item's first decoded frame —
    /// or, with no video, to its playhead moving — or nil after `timeout`.
    func waitForFirstFrame(audioOnly: Bool, timeout: Double) async -> Int? {
        guard let item = player.currentItem else { return nil }
        let start = item.currentTime()
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if audioOnly {
                if item.status == .readyToPlay,
                   CMTimeGetSeconds(item.currentTime() - start) > 0.1 {
                    return Int(Date().timeIntervalSince(loadStarted) * 1000)
                }
            } else if let output = videoOutput,
                      output.hasNewPixelBuffer(forItemTime: item.currentTime()) {
                return Int(Date().timeIntervalSince(loadStarted) * 1000)
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return nil
    }

    /// Every access-log event of the current item: what AVPlayer counted as
    /// transferred, and the bandwidth it estimated from it.
    func dumpAccessLog(label: String) {
        guard let events = player.currentItem?.accessLog()?.events else { return }
        for (index, event) in events.enumerated() {
            log(String(
                format: "accesslog %@ #%d uri=%@ requests=%d bytes=%lld transfer=%.2fs observed=%.0f indicated=%.0f downloaded=%.1fs stalls=%d",
                label, index, (event.uri ?? "-") as NSString, event.numberOfMediaRequests,
                event.numberOfBytesTransferred, event.transferDuration, event.observedBitrate,
                event.indicatedBitrate, event.segmentsDownloadedDuration, event.numberOfStalls
            ))
        }
    }

    // MARK: - Observation

    private func watch(_ item: AVPlayerItem) {
        observers.removeAll()
        notes.forEach(NotificationCenter.default.removeObserver)
        notes.removeAll()

        observers.append(item.observe(\.status) { [weak self] item, _ in
            Task { @MainActor in
                guard let self else { return }
                switch item.status {
                case .readyToPlay: self.log("item    readyToPlay after \(self.elapsed())")
                case .failed: self.log("item    FAILED: \(Self.describe(item.error))")
                default: break
                }
            }
        })
        observers.append(controller.observe(\.isReadyForDisplay) { [weak self] controller, _ in
            Task { @MainActor in
                guard let self, controller.isReadyForDisplay else { return }
                self.log("frame   ready for display after \(self.elapsed())")
            }
        })
        observers.append(player.observe(\.timeControlStatus) { [weak self] player, _ in
            Task { @MainActor in
                guard let self else { return }
                let status = ["paused", "waiting", "playing"][player.timeControlStatus.rawValue]
                let reason = player.reasonForWaitingToPlay?.rawValue ?? ""
                self.log("player  \(status) \(reason) at \(self.elapsed())")
            }
        })

        let center = NotificationCenter.default
        notes.append(center.addObserver(
            forName: AVPlayerItem.newAccessLogEntryNotification, object: item, queue: .main
        ) { [weak self] note in
            guard let event = (note.object as? AVPlayerItem)?.accessLog()?.events.last else { return }
            self?.log(String(
                format: "access  indicated=%.0f observed=%.0f bytes=%lld uri=%@ switchBW=%.0f",
                event.indicatedBitrate, event.observedBitrate, event.numberOfBytesTransferred,
                event.uri ?? "-", event.switchBitrate
            ))
        })
        notes.append(center.addObserver(
            forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main
        ) { [weak self] note in
            guard let event = (note.object as? AVPlayerItem)?.errorLog()?.events.last else { return }
            self?.log("error   \(event.errorDomain) \(event.errorStatusCode): \(event.errorComment ?? "-") uri=\(event.uri ?? "-")")
        })
        notes.append(center.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] note in
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.log("item    failed to play to end: \(Self.describe(error))")
        })
    }

    private func elapsed() -> String {
        String(format: "%.0f ms", Date().timeIntervalSince(loadStarted) * 1000)
    }

    private nonisolated static func describe(_ error: Error?) -> String {
        guard let error = error as NSError? else { return "unknown" }
        var text = "\(error.domain) \(error.code) \(error.localizedDescription)"
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " <- \(underlying.domain) \(underlying.code)"
        }
        return text
    }

    // MARK: - Autorun

    /// The step-0 run: for each content-type mode, play the first angle,
    /// switch to every other visit, and summarise what played.
    func autorun(secondsPerVisit: Double) async {
        guard let payload, !autorunning else { return }
        autorunning = true
        defer { autorunning = false }
        player.isMuted = true
        var summary: [String] = []
        for mode in AssetLoader.TypeMode.allCases {
            self.mode = mode
            reset()
            for (index, visit) in payload.visits.enumerated() {
                let position = index == 0 ? CMTime.zero : player.currentTime()
                play(visit, at: position)
                let name = payload.name(of: visit)
                let ms = await waitForFirstFrame(audioOnly: visit.angleId == "__audio__", timeout: 20)
                summary.append("\(mode.rawValue) \(name): \(ms.map { "first frame in \($0) ms" } ?? "NO FRAME")")
                try? await Task.sleep(nanoseconds: UInt64(secondsPerVisit * 1_000_000_000))
                dumpAccessLog(label: "\(mode.rawValue)/\(name)")
            }
            player.replaceCurrentItem(with: nil)
        }
        log("summary")
        summary.forEach { log("  \($0)") }
        log("done")
    }
}
