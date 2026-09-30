import AVFoundation

/// The ``Engine`` on AVPlayer: HLS through the player's ``UriRouter``, reported through
/// ``events``. The same behaviour as Android's `ExoEngine`, signal for signal.
///
/// Main thread only. AVFoundation reports from its own threads; every report hops to the main
/// queue before it reaches ``EventSink``.
public final class AVPlayerEngine: NSObject, Engine, @unchecked Sendable {
    private static let pollPeriod = 0.25

    public var events: EventSink?
    /// Borrowed by the full-screen presenter; never replaced.
    public let player = AVPlayer()

    private let router: UriRouter
    private let clock: Clock
    private let presenter: FullscreenPresenter?

    private var masterUri: String?
    private var item: AVPlayerItem?
    private var itemObservations: [NSKeyValueObservation] = []
    private var itemNotifications: [NSObjectProtocol] = []
    private var statusObservation: NSKeyValueObservation?
    private var lastStatus: AVPlayer.TimeControlStatus = .paused
    private var rate = 1.0
    private var metadataSent = false
    /// The item played to its end. Judged by the end notification, not the position: an item's
    /// last frame can sit short of its reported duration.
    private var ended = false
    private var failed = false
    private var stalled = false
    private var reportedBufferedEnd = -1.0
    private var poll: Cancellable?

    private var audioGroup: AVMediaSelectionGroup?
    private var audioOptions: [(id: String, option: AVMediaSelectionOption)] = []
    private var reportedAudio: (ids: [String], activeId: String?)?
    /// The audio a reattach restores once the rebuilt item lists it.
    private var restoreAudioId: String?

    public init(router: UriRouter, clock: Clock, options: CreateOptions, presenter: FullscreenPresenter?) {
        self.router = router
        self.clock = clock
        self.presenter = presenter
        super.init()
        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.timeControlStatusChanged() }
        }
    }

    public var hasVideo: Bool {
        guard let tracks = item?.tracks, !tracks.isEmpty else { return true }
        return MainActor.assumeIsolated { tracks.contains { $0.assetTrack?.mediaType == .video } }
    }

    // MARK: Source

    public func load(masterUri: String, startPosition: Double?) {
        self.masterUri = masterUri
        restoreAudioId = nil
        attach(startAt: startPosition)
    }

    /// The same item again, built from scratch: position is restored here, the rate stays on the
    /// player, and the audio choice comes back once the rebuilt item lists it.
    public func reattach() {
        guard masterUri != nil else { return }
        restoreAudioId = reportedAudio?.activeId
        let position = player.currentTime().seconds
        attach(startAt: position.isFinite ? position : nil)
    }

    private func attach(startAt position: Double?) {
        guard let masterUri, let url = URL(string: masterUri) else { return }
        detachItem()
        metadataSent = false
        ended = false
        failed = false
        stalled = false
        reportedBufferedEnd = -1
        audioGroup = nil
        audioOptions = []
        reportedAudio = nil

        let asset = AVURLAsset(url: url)
        asset.resourceLoader.setDelegate(router, queue: router.queue)
        let item = AVPlayerItem(asset: asset)
        self.item = item
        observe(item)
        player.replaceCurrentItem(with: item)
        if let position, position > 0 {
            player.seek(to: Self.time(position), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        startPolling()
    }

    private func detachItem() {
        itemObservations.forEach { $0.invalidate() }
        itemObservations = []
        itemNotifications.forEach(NotificationCenter.default.removeObserver)
        itemNotifications = []
        item = nil
    }

    // MARK: Transport

    /// A finished item plays again from the start, as a video element does. AVPlayer would stay
    /// at the end and wait there.
    public func play() {
        if ended {
            ended = false
            player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
                guard finished else { return }
                DispatchQueue.main.async { self?.events?.seeked() }
            }
        }
        if rate == 1 {
            player.play()
        } else {
            player.rate = Float(rate)
        }
    }

    public func pause() {
        player.pause()
    }

    public func seek(position: Double, exact: Bool) {
        ended = false
        let tolerance: CMTime = exact ? .zero : .positiveInfinity
        player.seek(to: Self.time(position), toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] finished in
            guard finished else { return }
            DispatchQueue.main.async { self?.events?.seeked() }
        }
    }

    public func setRate(_ rate: Double) {
        self.rate = rate
        if player.rate != 0 { player.rate = Float(rate) }
    }

    /// Never reached: AVPlayer cannot pin a rendition, so `variantSwitching` is false and the
    /// registry refuses the call.
    public func setVariant(_ id: String) {}

    public func setAudioTrack(_ id: String) {
        guard let item, let group = audioGroup,
              let option = audioOptions.first(where: { $0.id == id })?.option else { return }
        item.select(option, in: group)
    }

    public func snapshot() -> Snapshot {
        let position = player.currentTime().seconds
        return Snapshot(
            currentTime: position.isFinite ? max(0, position) : 0,
            duration: metadataSent ? duration() : 0,
            bufferedEnd: bufferedEnd(),
            playing: player.timeControlStatus != .paused
        )
    }

    // MARK: Presentation

    public func enterFullscreen() {
        guard let presenter else { return }
        let presented = presenter.present(player) { [weak self] in self?.leaveFullscreenByViewer() }
        if presented { events?.presentationChanged("fullscreen") }
    }

    public func exitFullscreen() {
        if presenter?.dismiss() == true { events?.presentationChanged("inline") }
    }

    /// The viewer leaving full-screen does what `exitFullscreen` does, pause included.
    private func leaveFullscreenByViewer() {
        exitFullscreen()
        if hasVideo { player.pause() }
    }

    public func destroy() {
        poll?.cancel()
        poll = nil
        _ = presenter?.dismiss()
        statusObservation?.invalidate()
        statusObservation = nil
        detachItem()
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    // MARK: What AVFoundation reports

    private func observe(_ item: AVPlayerItem) {
        itemObservations = [
            item.observe(\.status, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.itemStatusChanged() }
            },
            item.observe(\.duration, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.durationChanged() }
            },
        ]
        let center = NotificationCenter.default
        itemNotifications = [
            center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) {
                [weak self] _ in
                self?.ended = true
                self?.events?.ended()
            },
            center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) {
                [weak self] note in
                self?.fail(note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)
            },
            center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) {
                [weak self] _ in self?.stall()
            },
            center.addObserver(forName: AVPlayerItem.mediaSelectionDidChangeNotification, object: item, queue: .main) {
                [weak self] _ in self?.reportAudio()
            },
        ]
    }

    private func itemStatusChanged() {
        guard let item else { return }
        switch item.status {
        case .readyToPlay:
            announceMetadata()
            loadAudioGroup(of: item)
        case .failed:
            fail(item.error)
        default:
            break
        }
    }

    private func durationChanged() {
        if metadataSent { events?.durationChanged(duration()) } else { announceMetadata() }
    }

    /// Once per load, when the duration is known, or known to be unbounded.
    private func announceMetadata() {
        guard !metadataSent, item?.status == .readyToPlay else { return }
        let duration = duration()
        if duration == 0 { return }
        metadataSent = true
        events?.readyToPlay(duration: duration)
    }

    /// 0 until known; nil while unbounded (live). Read only once the item is ready: before that
    /// AVPlayerItem reports every duration as indefinite.
    private func duration() -> Double? {
        guard let duration = item?.duration else { return 0 }
        if duration.isIndefinite { return nil }
        return duration.isNumeric ? duration.seconds : 0
    }

    private func timeControlStatusChanged() {
        let status = player.timeControlStatus
        guard status != lastStatus else { return }
        lastStatus = status
        switch status {
        case .playing:
            if stalled {
                stalled = false
                events?.stalled(false)
            }
            events?.playing()
        case .paused:
            // Reaching the end pauses the player too; that is `ended`, not a pause.
            if !ended && !atEnd { events?.paused() }
        case .waitingToPlayAtSpecifiedRate:
            if player.reasonForWaitingToPlay != .noItemToPlay { events?.buffering() }
        @unknown default:
            break
        }
    }

    private var atEnd: Bool {
        guard let item, item.duration.isNumeric else { return false }
        return item.currentTime().seconds >= item.duration.seconds - 0.05
    }

    /// AVPlayer's own verdict; cleared when it is playing again.
    private func stall() {
        guard !stalled else { return }
        stalled = true
        events?.stalled(true)
    }

    /// Fatal at once until phase 3 puts the recovery ladder in front of it; once per item.
    private func fail(_ error: Error?) {
        guard !failed else { return }
        failed = true
        let error = error ?? NSError(domain: AVFoundationErrorDomain, code: AVError.unknown.rawValue)
        events?.error(
            category: errorCategory(of: error),
            fatal: true,
            code: errorCode(of: error),
            message: error.localizedDescription
        )
    }

    // MARK: Audio

    private func loadAudioGroup(of item: AVPlayerItem) {
        let expected = ObjectIdentifier(item)
        let loaded: @Sendable (AVMediaSelectionGroup?, (any Error)?) -> Void = { [weak self] group, _ in
            nonisolated(unsafe) let group = group
            DispatchQueue.main.async {
                guard let self, let item = self.item, ObjectIdentifier(item) == expected else { return }
                self.audioGroupLoaded(group, in: item)
            }
        }
        MainActor.assumeIsolated {
            item.asset.loadMediaSelectionGroup(for: .audible, completionHandler: loaded)
        }
    }

    private func audioGroupLoaded(_ group: AVMediaSelectionGroup?, in item: AVPlayerItem) {
        guard let group else { return }
        audioGroup = group
        var seen: Set<String> = []
        audioOptions = group.options.enumerated().map { index, option in
            // The rendition's NAME; the same master gives the same ids after a reattach.
            let name = option.displayName
            let id = seen.insert(name).inserted ? name : "\(name)#\(index)"
            return (id, option)
        }
        if let restore = restoreAudioId, let option = audioOptions.first(where: { $0.id == restore })?.option {
            item.select(option, in: group)
        }
        restoreAudioId = nil
        reportAudio()
    }

    /// The empty list on load / reattach is ``PlayerHost``'s; the engine reports only a real one.
    private func reportAudio() {
        guard let item, let group = audioGroup, !audioOptions.isEmpty else { return }
        let selected = item.currentMediaSelection.selectedMediaOption(in: group)
        let activeId = audioOptions.first { $0.option == selected }?.id
        let ids = audioOptions.map(\.id)
        if let reported = reportedAudio, reported.ids == ids, reported.activeId == activeId { return }
        reportedAudio = (ids, activeId)
        events?.audioTracks(
            audioOptions.map { AudioTrack(id: $0.id, lang: $0.option.extendedLanguageTag, label: $0.option.displayName) },
            activeId: activeId
        )
    }

    // MARK: The buffered end, sampled on the clock; EventSink holds `progress` to 1 Hz

    private func startPolling() {
        guard poll == nil else { return }
        poll = clock.schedule(Self.pollPeriod) { [weak self] in self?.sample() }
    }

    private func sample() {
        let end = bufferedEnd()
        if metadataSent, end != reportedBufferedEnd {
            reportedBufferedEnd = end
            events?.bufferedTo(end)
        }
        poll = clock.schedule(Self.pollPeriod) { [weak self] in self?.sample() }
    }

    /// The end of the loaded range containing the playhead; 0 when none does.
    private func bufferedEnd() -> Double {
        guard let item else { return 0 }
        let now = item.currentTime()
        for value in item.loadedTimeRanges {
            let range = value.timeRangeValue
            if now >= range.start, now <= range.end { return range.end.seconds }
        }
        return 0
    }

    private static func time(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 600)
    }
}
