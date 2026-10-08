import AVFoundation

/// The ``Engine`` on AVPlayer: HLS through the player's ``UriRouter``, reported through
/// ``events``. The same behaviour as Android's `ExoEngine`, signal for signal.
///
/// Main thread only. AVFoundation reports from its own threads; every report hops to the main
/// queue before it reaches ``EventSink``.
public final class AVPlayerEngine: NSObject, Engine, @unchecked Sendable {
    private static let pollPeriod = 0.25

    public var events: EventSink?
    /// Borrowed by the presenters. Replaced only when iOS resets its media services, which leaves
    /// every AVFoundation object dead: see ``recreatePlayerAfterMediaServicesReset()``.
    public private(set) var player = AVPlayer()

    private let router: UriRouter
    private let clock: Clock
    private let presenter: FullscreenPresenter?
    private let inline: InlinePresenter?
    /// Where JavaScript asked for the video, kept for the presenter to take up again.
    private var inlineFrame: InlineFrame?
    /// The skip intervals, for the lock screen and the full-screen controls.
    private let skin: SkinOptions

    private var masterUri: String?
    private var item: AVPlayerItem?
    private var itemObservations: [NSKeyValueObservation] = []
    private var itemNotifications: [NSObjectProtocol] = []
    private var statusObservation: NSKeyValueObservation?
    private var rateObservations: [NSKeyValueObservation] = []
    private var fullscreenTexts = FullscreenTexts()
    /// Full-screen holds the picture: picture in picture starts from its view, not the inline one.
    private var presentation = Presentation.inline
    #if os(iOS)
    /// Watches for AirPlay devices while the engine lives: detection costs battery, and the page
    /// only draws its control while there is a device to send to.
    private var routeDetector: AVRouteDetector?
    private var routeObservation: NSKeyValueObservation?
    private var externalPlaybackObservation: NSKeyValueObservation?
    #endif
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
    private var nowPlaying: NowPlayingController?
    private var ladder: RecoveryLadder?
    /// Whether playback should be running: every play and pause, whoever made it, and the end
    /// of the item, which is what the viewer asked for; but not a failure, which stops the player
    /// without the viewer asking. A re-attach resumes from it.
    private var intendedPlaying = false
    private var interruptionObserver: NSObjectProtocol?
    private var mediaServicesObserver: NSObjectProtocol?
    /// Playing when an interruption began, so it resumes when the system says it may.
    private var playingBeforeInterruption = false

    private var audioGroup: AVMediaSelectionGroup?
    private var audioOptions: [(id: String, option: AVMediaSelectionOption)] = []
    private var reportedAudio: (ids: [String], activeId: String?)?
    /// The audio a reattach restores once the rebuilt item lists it.
    private var restoreAudioId: String?

    public init(
        router: UriRouter,
        clock: Clock,
        options: CreateOptions,
        presenter: FullscreenPresenter?,
        inline: InlinePresenter? = nil
    ) {
        self.router = router
        self.clock = clock
        self.presenter = presenter
        self.inline = inline
        skin = SkinOptions(skipBackSeconds: options.skipBackSeconds, skipForwardSeconds: options.skipForwardSeconds)
        super.init()
        observePlayer()
        #if os(iOS)
        let detector = AVRouteDetector()
        detector.isRouteDetectionEnabled = true
        routeDetector = detector
        routeObservation = detector.observe(\.multipleRoutesDetected, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.reportAirPlay() }
        }
        #endif
        nowPlaying = NowPlayingController(skin: skin, commands: .init(
            play: { [weak self] in self?.play() },
            pause: { [weak self] in self?.pause() },
            seek: { [weak self] position in self?.seek(position: position, exact: false) },
            skip: { [weak self] seconds in self?.skip(by: seconds) }
        ))
        observeInterruptions()
        // Turning the phone sideways while a landscape video plays in the page opens full-screen,
        // as a video app does; a portrait video, a paused one and audio stay where they are.
        inline?.onRotatedToPortrait = { [weak self] in self?.turnedWhileLoading = false }
        inline?.onPictureInPicture = { [weak self] active in
            // Started from the inline picture, which stays the picture's source: nothing lets go
            // of the player, and `inline` is what the page goes back to.
            self?.events?.presentationChanged((active ? Presentation.pip : Presentation.inline).rawValue)
        }
        inline?.onRotatedToLandscape = { [weak self] in
            // Before the picture's size is known the turn counts: a viewer who turns the phone while
            // the video loads wants the big picture, and full-screen has its own spinner. A video
            // that turns out upright is let go of once its size is known (`leaveIfUpright`).
            guard let self, self.hasVideo else { return }
            // Turned before anything plays and before the size is known: the page starts playback
            // a moment later (`play`), and the turn is remembered until then.
            if !self.intendedPlaying && !self.pictureSizeKnown { self.turnedWhileLoading = true; return }
            guard self.intendedPlaying, self.videoIsLandscape || !self.pictureSizeKnown else { return }
            self.fullscreenBeforeSizeKnown = !self.pictureSizeKnown
            self.enterFullscreen(texts: nil)
        }
        ladder = RecoveryLadder(policy: .default, clock: clock, hooks: .init(
            // AVPlayer offers no in-place repair: the rung is skipped rather than pretended.
            recoverInPlace: { _ in false },
            reattach: { [weak self] in self?.reattach() },
            requestReload: { [weak self] reason, attempt in self?.events?.reloadRequested(reason: reason.rawValue, attempt: attempt) },
            onExhausted: { [weak self] failure in
                // Full-screen would hold a frozen picture: the viewer is taken back to the page,
                // where the host shows the error and the way to try again (plan 05).
                self?.exitFullscreen()
                self?.events?.error(category: failure.category, fatal: true, code: failure.code, message: failure.message)
            }
        ))
    }

    /// The picture is wider than tall: what turning the phone sideways is for. False until known.
    private var fullscreenBeforeSizeKnown = false
    private var turnedWhileLoading = false

    private var pictureSizeKnown: Bool {
        guard let size = item?.presentationSize else { return false }
        return size.width > 0 && size.height > 0
    }

    /// Full-screen opened by a turn of the phone before the size was known, on a video that is
    /// upright: the viewer is taken back to the page, where an upright video belongs.
    private func leaveIfUpright() {
        guard fullscreenBeforeSizeKnown, pictureSizeKnown else { return }
        fullscreenBeforeSizeKnown = false
        if !videoIsLandscape { exitFullscreen() }
    }

    public var videoIsLandscape: Bool {
        guard let size = item?.presentationSize, size.width > 0, size.height > 0 else { return false }
        return size.width > size.height
    }

    /// True until the tracks say otherwise. A track that has not reported its type yet may be
    /// video: AVPlayer rebuilds the list on a seek past the buffer, and for a moment it shows none.
    public var hasVideo: Bool {
        guard let tracks = item?.tracks, !tracks.isEmpty else { return true }
        return MainActor.assumeIsolated {
            tracks.contains { $0.assetTrack == nil || $0.assetTrack?.mediaType == .video }
        }
    }

    // MARK: The player

    /// Everything that belongs to the current `AVPlayer`, so a replacement gets the same wiring.
    private func observePlayer() {
        // The stream's DEFAULT=YES audio, as on the web, not the phone's language preferences.
        player.appliesMediaSelectionCriteriaAutomatically = false
        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.timeControlStatusChanged() }
        }
        // AVKit's speed menu sets the player's rate, and its default rate when paused.
        rateObservations.append(player.observe(\.rate, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.playerRateChanged() }
        })
        if #available(iOS 16.0, macOS 13.0, *) {
            rateObservations.append(player.observe(\.defaultRate, options: [.new]) { [weak self] player, _ in
                DispatchQueue.main.async { self?.viewerPickedRate(Double(player.defaultRate)) }
            })
        }
        rateObservations.append(player.observe(\.isMuted, options: [.new]) { [weak self] player, _ in
            let muted = player.isMuted
            DispatchQueue.main.async { self?.events?.mutedChanged(muted) }
        })
        #if os(iOS)
        player.allowsExternalPlayback = true
        externalPlaybackObservation = player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.reportAirPlay() }
        }
        #endif
        // Video goes on as audio in the background, and into picture in picture where it can.
        player.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
    }

    private func unobservePlayer() {
        statusObservation?.invalidate()
        statusObservation = nil
        rateObservations.forEach { $0.invalidate() }
        rateObservations = []
        #if os(iOS)
        externalPlaybackObservation?.invalidate()
        externalPlaybackObservation = nil
        #endif
    }

    /// iOS resets its media services now and then (the system's media daemon restarts): every
    /// AVFoundation object is dead afterwards, the player and its item included, and playback
    /// would stay silent until the app was restarted. A new player takes over: the same wiring,
    /// the mute, the picture in the page, and the item built again from where the old one was.
    /// Full-screen held the dead player's picture, so the viewer is taken back to the page.
    public func recreatePlayerAfterMediaServicesReset() {
        guard nowPlaying != nil else { return }
        let position = player.currentTime().seconds
        let resume = intendedPlaying
        let muted = player.isMuted
        restoreAudioId = reportedAudio?.activeId
        _ = presenter?.dismiss()
        unobservePlayer()
        detachItem()
        player = AVPlayer()
        observePlayer()
        player.isMuted = muted
        inline?.setFrame(inlineFrame, player: player)
        lastStatus = .paused
        guard masterUri != nil else { return }
        attach(startAt: position.isFinite && position > 0 ? position : nil)
        if resume { play() }
    }

    // MARK: Source

    public func load(masterUri: String, startPosition: Double?, nowPlaying metadata: NowPlaying?, recovery: RecoveryPolicy) {
        self.masterUri = masterUri
        restoreAudioId = nil
        nowPlaying?.setMetadata(metadata)
        ladder?.setPolicy(recovery)
        // The reload the ladder asked for picks up what the viewer asked for, even when playback
        // never got going: the controller resumes only what it saw playing.
        let resume = ladder?.pendingReload == true && intendedPlaying
        ladder?.noteSourceLoaded()
        attach(startAt: startPosition)
        if resume { play() }
    }

    /// The same item again, built from scratch: position is restored here, the rate stays on the
    /// player, and the audio choice comes back once the rebuilt item lists it.
    public func reattach() {
        guard masterUri != nil else { return }
        restoreAudioId = reportedAudio?.activeId
        let position = player.currentTime().seconds
        let resume = intendedPlaying
        inline?.holdPicture()
        attach(startAt: position.isFinite ? position : nil)
        if resume { play() }
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
        intendedPlaying = true
        activateAudioSession()
        if turnedWhileLoading {
            turnedWhileLoading = false
            if hasVideo {
                fullscreenBeforeSizeKnown = !pictureSizeKnown
                enterFullscreen(texts: nil)
            }
        }
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
        intendedPlaying = false
        player.pause()
    }

    public func seek(position: Double, exact: Bool) {
        ended = false
        let tolerance: CMTime = exact ? .zero : .positiveInfinity
        player.seek(to: Self.time(position), toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak self] finished in
            guard finished else { return }
            DispatchQueue.main.async {
                self?.events?.seeked()
                self?.publishPlayback()
            }
        }
    }

    /// A lock-screen skip: the playhead moved by `seconds`, kept inside the item.
    private func skip(by seconds: Double) {
        let now = player.currentTime().seconds
        guard now.isFinite else { return }
        var target = max(0, now + seconds)
        if let duration = duration(), duration > 0 { target = min(target, duration) }
        seek(position: target, exact: false)
    }

    public func setRate(_ rate: Double) {
        self.rate = roundedRate(rate)
        if #available(iOS 16.0, macOS 13.0, *) { player.defaultRate = Float(self.rate) }
        if player.rate != 0 { player.rate = Float(self.rate) }
        events?.rateChanged(self.rate)
        publishPlayback()
    }

    /// A pause sets the rate to 0, which is not a rate change.
    private func playerRateChanged() {
        viewerPickedRate(Double(player.rate))
    }

    /// A rate the player reports that is not the one asked for: the viewer's pick in AVKit.
    private func viewerPickedRate(_ reported: Double) {
        guard reported > 0 else { return }
        let picked = roundedRate(reported)
        guard picked != rate else { return }
        rate = picked
        events?.rateChanged(rate)
        publishPlayback()
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

    public func setMuted(_ muted: Bool) {
        player.isMuted = muted
    }

    /// The system's own device list, over the page.
    public func showAirPlayPicker() {
        _ = inline?.showRoutePicker()
    }

    private func reportAirPlay() {
        #if os(iOS)
        events?.airPlayChanged(
            available: routeDetector?.multipleRoutesDetected ?? false,
            active: player.isExternalPlaybackActive
        )
        #endif
    }

    /// The subtitle the master lists under `label`: matched against an option's name or language.
    public func setSubtitleTrack(_ label: String?) {
        guard let item else { return }
        let expected = ObjectIdentifier(item)
        let loaded: @Sendable (AVMediaSelectionGroup?, (any Error)?) -> Void = { [weak self] group, _ in
            nonisolated(unsafe) let group = group
            DispatchQueue.main.async {
                guard let self, let item = self.item, ObjectIdentifier(item) == expected, let group else { return }
                guard let label else { return item.select(nil, in: group) }
                let option = group.options.first { option in
                    option.displayName == label || option.extendedLanguageTag == label
                        || option.locale?.languageCode == label
                }
                if let option { item.select(option, in: group) }
            }
        }
        MainActor.assumeIsolated {
            item.asset.loadMediaSelectionGroup(for: .legible, completionHandler: loaded)
        }
    }

    /// From the full-screen view while it holds the picture, otherwise from the inline one.
    public func startPictureInPicture() {
        if presentation == .fullscreen {
            _ = presenter?.startPictureInPicture()
        } else {
            _ = inline?.startPictureInPicture()
        }
    }

    public func setInlineFrame(_ frame: InlineFrame?) {
        inlineFrame = frame
        inline?.setFrame(frame, player: player)
    }

    /// Whichever of full-screen and picture in picture holds the picture, the inline view has
    /// none; it takes the player back when both are gone.
    private func presentationDidChange(_ presentation: Presentation) {
        self.presentation = presentation
        inline?.setSuspended(presentation != .inline)
        events?.presentationChanged(presentation.rawValue)
    }

    /// Audio-only has no view: there is nothing to show full-screen. The texts are the last the
    /// host sent, so a turn of the phone that opens full-screen on its own speaks the same language.
    public func enterFullscreen(texts: [String: String]?) {
        if let texts { fullscreenTexts = FullscreenTexts(overriding: texts) }
        guard let presenter, hasVideo else { return }
        let presented = presenter.present(
            player,
            commands: fullscreenCommands(),
            texts: fullscreenTexts,
            onLeave: { [weak self] in self?.leaveFullscreenByViewer() },
            onPresentation: { [weak self] presentation in self?.presentationDidChange(presentation) }
        )
        if presented { presentationDidChange(.fullscreen) }
    }

    private func fullscreenCommands() -> FullscreenCommands {
        FullscreenCommands(
            play: { [weak self] in self?.play() },
            pause: { [weak self] in self?.pause() },
            seek: { [weak self] position in self?.seek(position: position, exact: false) },
            setRate: { [weak self] rate in self?.setRate(rate) },
            rate: { [weak self] in self?.rate ?? 1 },
            setAudioTrack: { [weak self] id in self?.setAudioTrack(id) },
            audioTracks: { [weak self] in self?.currentAudio() ?? ([], nil) },
            playbackWanted: { [weak self] in self?.intendedPlaying ?? false },
            skin: skin
        )
    }

    public func exitFullscreen() {
        if presenter?.dismiss() == true { presentationDidChange(.inline) }
    }

    /// The viewer leaving full-screen does what `exitFullscreen` does, pause included, unless the
    /// video is shown in the page: it plays on there.
    private func leaveFullscreenByViewer() {
        fullscreenBeforeSizeKnown = false
        exitFullscreen()
        if hasVideo, inlineFrame == nil { pause() }
    }

    public func destroy() {
        ladder?.destroy()
        ladder = nil
        nowPlaying?.clear()
        nowPlaying = nil
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        if let mediaServicesObserver { NotificationCenter.default.removeObserver(mediaServicesObserver) }
        mediaServicesObserver = nil
        poll?.cancel()
        poll = nil
        _ = presenter?.dismiss()
        inline?.setFrame(nil, player: player)
        #if os(iOS)
        routeDetector?.isRouteDetectionEnabled = false
        routeDetector = nil
        routeObservation?.invalidate()
        routeObservation = nil
        #endif
        unobservePlayer()
        detachItem()
        player.pause()
        player.replaceCurrentItem(with: nil)
        // After the player has stopped: the session cannot be deactivated under a running one.
        deactivateAudioSession()
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
            item.observe(\.tracks, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.tracksChanged() }
            },
        ]
        let center = NotificationCenter.default
        itemNotifications = [
            center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) {
                [weak self] _ in
                self?.ended = true
                // Done, not paused: the controls offer play, as the web's do at `ended`.
                self?.intendedPlaying = false
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
            center.addObserver(forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main) {
                [weak self] _ in self?.errorLogged()
            },
        ]
    }

    private func itemStatusChanged() {
        guard let item else { return }
        switch item.status {
        case .readyToPlay:
            announceMetadata()
            loadAudioGroup(of: item)
            leaveIfUpright()
        case .failed:
            fail(item.error)
        default:
            break
        }
    }

    /// A view raised before the tracks were known comes down once they show no video. Playback
    /// goes on: only the empty view leaves.
    private func tracksChanged() {
        nowPlaying?.setHasVideo(hasVideo)
        if !hasVideo { exitFullscreen() }
        leaveIfUpright()
    }

    private func durationChanged() {
        if metadataSent { events?.durationChanged(duration()) } else { announceMetadata() }
        publishPlayback()
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
        publishPlayback()
        switch status {
        case .playing:
            intendedPlaying = true
            ladder?.notePlaybackHealthy()
            if stalled {
                stalled = false
                events?.stalled(false)
            }
            events?.playing()
        case .paused:
            // A failed item stops the player too; that is the ladder's to report, not a pause,
            // so the controller still knows the viewer was watching when the source is rebuilt.
            if failed || item?.status == .failed { break }
            // Reaching the end pauses the player too; that is `ended`, not a pause.
            if ended || atEnd { break }
            intendedPlaying = false
            events?.paused()
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

    /// Once per item, into the recovery ladder: fatal only once the ladder is spent.
    private func fail(_ error: Error?) {
        guard !failed else { return }
        failed = true
        let error = error ?? NSError(domain: AVFoundationErrorDomain, code: AVError.unknown.rawValue)
        ladder?.note(.init(category: errorCategory(of: error), code: errorCode(of: error), message: error.localizedDescription))
    }

    /// A request failed. AVPlayer logs failures it gets past too, so an entry counts only while
    /// playback is stuck waiting for data the viewer asked to see: then it is a wedge, and the
    /// ladder starts in seconds rather than when AVPlayer gives the item up, which can take a
    /// minute. A burst of entries buys one rung at a time.
    private func errorLogged() {
        guard intendedPlaying, !failed, player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
              let entry = item?.errorLog()?.events.last else { return }
        let error = NSError(
            domain: entry.errorDomain,
            code: entry.errorStatusCode,
            userInfo: [NSLocalizedDescriptionKey: entry.errorComment ?? "Request failed"]
        )
        ladder?.note(
            .init(category: errorCategory(of: error), code: errorCode(of: error), message: error.localizedDescription),
            reason: .wedged
        )
    }

    public func setAppSuspended(_ suspended: Bool) {
        ladder?.setAppSuspended(suspended)
    }

    public func takeHeldReload() -> PendingReload? {
        ladder?.takeHeldReload()
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
        let options = group.options
        let keys = options.map(Self.audioKey)
        audioOptions = AudioRenditions.tracks(keys: keys).map { ($0.id, options[$0.index]) }
        if let restore = restoreAudioId, let option = audioOptions.first(where: { $0.id == restore })?.option {
            item.select(option, in: group)
        } else if let option = group.defaultOption ?? audioOptions.first?.option {
            // A master that marks no DEFAULT=YES starts on its first track, as the web does.
            item.select(option, in: group)
        }
        restoreAudioId = nil
        reportAudio()
    }

    /// The empty list on load / reattach is ``PlayerHost``'s; the engine reports only a real one.
    private func reportAudio() {
        guard !audioOptions.isEmpty else { return }
        let (tracks, activeId) = currentAudio()
        let ids = tracks.map(\.id)
        if let reported = reportedAudio, reported.ids == ids, reported.activeId == activeId { return }
        reportedAudio = (ids, activeId)
        events?.audioTracks(tracks, activeId: activeId)
    }

    /// The audio tracks, and the one the selected rendition belongs to, whichever tier is playing.
    private func currentAudio() -> (tracks: [AudioTrack], activeId: String?) {
        guard let item, let group = audioGroup else { return ([], nil) }
        let selected = item.currentMediaSelection.selectedMediaOption(in: group).map(Self.audioKey)
        return (
            audioOptions.map { AudioTrack(id: $0.id, lang: $0.option.extendedLanguageTag, label: $0.option.displayName) },
            audioOptions.first { $0.id == selected }?.id
        )
    }

    private static func audioKey(_ option: AVMediaSelectionOption) -> String {
        AudioRenditions.key(language: option.extendedLanguageTag, name: option.displayName)
    }

    // MARK: Now playing, the audio session and interruptions

    /// Where playback stands, for Control Center and the lock screen.
    private func publishPlayback() {
        let elapsed = player.currentTime().seconds
        nowPlaying?.update(
            duration: metadataSent ? duration() : 0,
            elapsed: elapsed.isFinite ? elapsed : 0,
            // Waiting for data is still playing, as far as the viewer is concerned.
            rate: player.timeControlStatus == .paused ? 0 : rate
        )
    }

    /// A playback session: it plays with the ringer switched off, and on with the screen locked.
    private func activateAudioSession() {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback)
        try? session.setActive(true)
        #endif
    }

    /// Hands the audio back: another app the session interrupted (music, a podcast) may resume.
    /// Only on destroy; a pause keeps the session, so the lock screen keeps its controls.
    private func deactivateAudioSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    /// A call or an alarm pauses playback; it resumes afterwards when the system says it should.
    /// Unplugged headphones need nothing here: AVPlayer pauses, and `pause` follows.
    private func observeInterruptions() {
        #if os(iOS)
        mediaServicesObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.recreatePlayerAfterMediaServicesReset() }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                self.playingBeforeInterruption = self.lastStatus != .paused
            case .ended:
                let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                    .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
                if self.playingBeforeInterruption, options.contains(.shouldResume) { self.play() }
                self.playingBeforeInterruption = false
            @unknown default:
                break
            }
        }
        #endif
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
