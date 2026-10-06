/// The engine's only outbound path. Stamps every event with its player and load, and enforces
/// the emission rules in `conformance/README.md` on the clock. An engine reports what happened;
/// whether and when that becomes an event is decided here, the same way on every engine.
public final class EventSink {
    public typealias Emit = (_ name: String, _ payload: [String: JSON]) -> Void

    private static let timeupdatePeriod = 0.25
    private static let progressPeriod = 1.0

    private let playerId: String
    private let clock: Clock
    private let variantSwitching: Bool
    private let emit: Emit
    /// The playhead, read when a periodic `timeupdate` fires.
    private let position: () -> Double

    private var loadId: String?
    private var silent = false
    private var duration: Double? = 0
    /// A new player plays at 1; a load keeps whatever rate the last one had.
    private var rate = 1.0
    private var tick: Cancellable?
    private var lastProgressAt: Double?
    private var heldProgress: Double?
    private var heldProgressTimer: Cancellable?

    public init(
        playerId: String,
        clock: Clock,
        variantSwitching: Bool,
        emit: @escaping Emit,
        position: @escaping () -> Double
    ) {
        self.playerId = playerId
        self.clock = clock
        self.variantSwitching = variantSwitching
        self.emit = emit
        self.position = position
    }

    /// A new load: what follows is stamped with it, and nothing of the last carries over.
    public func begin(loadId: String) {
        self.loadId = loadId
        duration = 0
        stopTicking()
        heldProgressTimer?.cancel()
        heldProgressTimer = nil
        lastProgressAt = nil
        heldProgress = nil
    }

    /// Nothing is emitted after this, whatever the engine still reports.
    public func close() {
        silent = true
        stopTicking()
        heldProgressTimer?.cancel()
        heldProgressTimer = nil
    }

    private func send(_ name: String, _ payload: [String: JSON] = [:]) {
        // Before the first load there is no load to stamp an event with.
        guard let loadId, !silent else { return }
        var stamped = payload
        stamped["playerId"] = .string(playerId)
        stamped["loadId"] = .string(loadId)
        emit(name, stamped)
    }

    // MARK: What the engine reports

    /// The item is ready: `durationchange` if it changed, then `loadedmetadata`.
    public func readyToPlay(duration: Double?) {
        durationChanged(duration)
        send("loadedmetadata", ["duration": Self.wire(self.duration)])
    }

    /// Nil while unbounded (live). In whole milliseconds: AVPlayer refines the duration as it
    /// loads, and the sub-millisecond part tells the host nothing.
    public func durationChanged(_ reported: Double?) {
        let duration = reported.map { ($0 * 1000).rounded() / 1000 }
        if duration == self.duration { return }
        self.duration = duration
        send("durationchange", ["duration": Self.wire(duration)])
    }

    private var muted = false

    /// Only on a change, whoever made it: a `setMuted`, or the viewer in native UI.
    public func mutedChanged(_ muted: Bool) {
        if muted == self.muted { return }
        self.muted = muted
        send("mutedchange", ["muted": .bool(muted)])
    }

    private var airPlay = (available: false, active: false)

    /// Only on a change: a device came or went, or playback moved to or from one.
    public func airPlayChanged(available: Bool, active: Bool) {
        if available == airPlay.available && active == airPlay.active { return }
        airPlay = (available, active)
        send("airplaychange", ["available": .bool(available), "active": .bool(active)])
    }

    /// Only on a change, whoever made it: a `setRate`, or the viewer in native UI.
    public func rateChanged(_ rate: Double) {
        if rate == self.rate { return }
        self.rate = rate
        send("ratechange", ["rate": .number(rate)])
    }

    public func playing() {
        send("playing")
        startTicking()
    }

    public func paused() {
        stopTicking()
        timeupdateNow()
        send("pause")
    }

    public func buffering() {
        send("waiting")
    }

    public func seeked() {
        timeupdateNow()
        send("seeked")
    }

    public func ended() {
        stopTicking()
        send("ended")
    }

    public func audioTracks(_ tracks: [AudioTrack], activeId: String?) {
        send("audiotracks-updated", [
            "tracks": .array(tracks.map(\.json)),
            "activeId": activeId.map(JSON.string) ?? .null,
        ])
    }

    /// Always empty unless `variantSwitching`, so there is nothing to announce.
    public func variants(_ variants: [Variant]) {
        if variantSwitching { send("variants-updated", ["variants": .array(variants.map(\.json))]) }
    }

    /// The end of the buffered range containing the playhead; at most one `progress` a second.
    public func bufferedTo(_ end: Double) {
        let now = clock.now()
        guard let last = lastProgressAt, now - last < Self.progressPeriod else {
            lastProgressAt = now
            send("progress", ["bufferedEnd": .number(end)])
            return
        }
        // Held: the latest value goes out when the window ends.
        heldProgress = end
        if heldProgressTimer == nil {
            heldProgressTimer = clock.schedule(last + Self.progressPeriod - now) { [weak self] in
                guard let self else { return }
                heldProgressTimer = nil
                lastProgressAt = clock.now()
                if let held = heldProgress { send("progress", ["bufferedEnd": .number(held)]) }
                heldProgress = nil
            }
        }
    }

    /// Only on the engine's own verdict, never from a timer.
    public func stalled(_ stalled: Bool) {
        send("stalled", ["stalled": .bool(stalled)])
    }

    public func error(category: String, fatal: Bool, code: String, message: String) {
        send("error", [
            "category": .string(category),
            "fatal": .bool(fatal),
            "code": .string(code),
            "message": .string(message),
        ])
    }

    /// The engine needs the munged source rebuilt: the one repair it cannot make itself.
    public func reloadRequested(reason: String, attempt: Int) {
        send("reload-requested", ["reason": .string(reason), "attempt": .number(Double(attempt))])
    }

    /// `inline` means not presented.
    public func presentationChanged(_ state: String) {
        send("presentationchange", ["state": .string(state)])
    }

    // MARK: The 4 Hz timeupdate

    /// The 0.25 s period starts now; there is no `timeupdate` at the transition itself.
    private func startTicking() {
        stopTicking()
        tick = clock.schedule(Self.timeupdatePeriod) { [weak self] in self?.onTick() }
    }

    private func stopTicking() {
        tick?.cancel()
        tick = nil
    }

    private func onTick() {
        send("timeupdate", ["currentTime": .number(position())])
        tick = clock.schedule(Self.timeupdatePeriod) { [weak self] in self?.onTick() }
    }

    /// A `timeupdate` outside the period (seek, pause); a running period restarts from it.
    private func timeupdateNow() {
        send("timeupdate", ["currentTime": .number(position())])
        if tick != nil { startTicking() }
    }

    private static func wire(_ duration: Double?) -> JSON {
        duration.map(JSON.number) ?? .null
    }
}
