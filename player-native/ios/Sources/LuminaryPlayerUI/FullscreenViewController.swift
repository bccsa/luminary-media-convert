#if canImport(UIKit)
import AVFoundation
import AVKit
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The picture: a view whose layer is an `AVPlayerLayer`.
final class PlayerLayerView: UIView {
    override static var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

/// Native full-screen, drawn to `player-web`'s full-screen skin (plan 05): the picture, a 30%
/// scrim, play/pause and the skips in the middle, a row of menus at the top left, the progress
/// bar and the time along the bottom, exit at the bottom right. ``FullscreenControlsLayout`` and
/// ``FullscreenControlsVisibility`` decide what shows; this draws it. The viewer's actions go to
/// the engine through ``FullscreenCommands``; the picture is read straight from the player.
final class FullscreenViewController: UIViewController, UIGestureRecognizerDelegate {
    let videoView = PlayerLayerView()
    /// The viewer asked to leave: the exit button, or a double tap.
    var onLeave: (() -> Void)?
    var onPictureInPicture: (() -> Void)?
    var pictureInPictureAvailable = false {
        didSet { refresh() }
    }

    private let player: AVPlayer
    private let commands: FullscreenCommands
    private let texts: FullscreenTexts
    private let visibility: FullscreenControlsVisibility

    private let controls = UIView()
    private let playPause = GlyphButton(size: Skin.play, iconSize: Skin.playIcon, circle: true)
    private let spinner = SpinnerView()
    private let skipBack = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon, circle: true)
    private let skipForward = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon, circle: true)
    private let audioButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let pipButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let subtitlesButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let rateButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let muteButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let exitButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let browseButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    /// Apple's own AirPlay control: it draws the glyph, shows casting in its tint, and opens the
    /// system's device list. Hidden unless the detector finds a device to send to.
    private let airPlayButton = AVRoutePickerView()
    private let routeDetector = AVRouteDetector()
    private var routeObservation: NSKeyValueObservation?
    private let progress = ProgressBar()
    private let timeLabel = UILabel()
    private let remainingLabel = UILabel()
    private let fade = FadeView()
    /// "Chapter 4 of 7" above the bar.
    private let chapterLabel = UILabel()
    /// The chapters and up next the panel lists; nil while there are none, and then there is no button.
    private var browse: Browse?
    private var panel: BrowsePanel?
    /// The videos the strip near the end offers, best first.
    private var nextUpItems: [BrowseItem] = []
    /// Chosen or closed: either way the strip has done its job for this video.
    private var nextUpClosed = false
    private var nextUpStrip: NextUpStrip?
    /// Where the video is, not where a finger on the bar is.
    private var playhead: Double = 0
    /// The frames shown above the timeline while it is held, and the time under the finger.
    private let roster = RosterView()
    private let rosterLabel = PillLabel()
    private var rosterFraction: Double?
    /// The roster is pinned: left open after the finger lifted, centred on the playhead, and dragged or
    /// tapped on its own for the slow, precise way through the video (the bar is the fast one).
    private var rosterPinned = false
    private var pinDrag: (startTime: Double, time: Double, moved: Bool)?
    /// Where the strip rests after a seek, until playback has caught up; else it snaps back to the old time.
    private var pinAnchor: Double?
    private var pinAnchorTimeout: DispatchWorkItem?
    private var pinLink: CADisplayLink?

    private var state = FullscreenControlsState()
    private var layout: FullscreenControlsLayout?
    private var menu: FullscreenMenu?
    /// The subtitles of the item playing, which a reattach or a load replaces.
    private var subtitles: (item: AVPlayerItem, group: AVMediaSelectionGroup, options: [AVMediaSelectionOption])?
    /// Where the viewer is dragging the progress bar to, until they let go.
    private var scrubbing: Double?
    /// The speed while paused, when the player's rate reads 0.
    private var rate: Double = 1
    private var timeObserver: Any?
    private var observations: [NSKeyValueObservation] = []

    init(player: AVPlayer, commands: FullscreenCommands, texts: FullscreenTexts, clock: Clock) {
        self.player = player
        self.commands = commands
        self.texts = texts
        visibility = FullscreenControlsVisibility(clock: clock)
        super.init(nibName: nil, bundle: nil)
        // The engine's speed, which is right while paused too; the player's own reads 0 then.
        rate = commands.rate()
        browse = commands.browse.flatMap { $0.isEmpty ? nil : $0 }
        nextUpItems = Array((commands.browse?.nextUp ?? []).prefix(NextUp.max))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Presentation

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    /// Whatever the app allows: full-screen follows how the phone is held, as on Android. A
    /// landscape video opened from a phone held upright turns it sideways (`turnToLandscape`),
    /// and turning it upright again leaves.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        turning ? .landscape : UIApplication.shared.supportedInterfaceOrientations(for: view.window)
    }

    /// The picture is wider than tall, so full-screen is landscape. Known once the item has a size.
    private var videoIsLandscape: Bool {
        guard let size = player.currentItem?.presentationSize, size.width > 0, size.height > 0 else { return false }
        return size.width > size.height
    }

    /// Asked of the system and not yet arrived: the turn is ours, not the viewer's.
    private var turning = false
    private var turned = false
    private weak var scene: UIWindowScene?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        scene = view.window?.windowScene
        turnToLandscape()
    }

    /// A landscape video opened from a phone held upright: full-screen turns sideways, as the
    /// viewer asked for the picture to fill the screen.
    private func turnToLandscape() {
        guard videoIsLandscape, let scene, scene.interfaceOrientation.isPortrait else { return }
        if #available(iOS 16.0, *) {
            turning = true
            turned = true
            setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape)) { [weak self] _ in
                DispatchQueue.main.async { self?.turning = false }
            }
        }
    }

    /// Back upright after a turn this view asked for.
    private func restorePortrait() {
        guard turned, let scene else { return }
        turned = false
        if #available(iOS 16.0, *) {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in }
        }
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // The phone turned upright while a landscape video fills the screen: back to the page.
        guard !turning, videoIsLandscape, size.height > size.width else { return }
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.turned = false
            self?.onLeave?()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.playerLayer.videoGravity = .resizeAspect
        view.addSubview(videoView)

        controls.backgroundColor = .clear
        view.addSubview(controls)
        controls.addSubview(fade)
        for button in [playPause, skipBack, skipForward, audioButton, pipButton, subtitlesButton, rateButton, muteButton, browseButton, exitButton] {
            controls.addSubview(button)
        }
        airPlayButton.tintColor = .white
        airPlayButton.activeTintColor = .systemYellow
        airPlayButton.prioritizesVideoDevices = true
        airPlayButton.delegate = self
        airPlayButton.isHidden = true
        controls.addSubview(airPlayButton)
        controls.addSubview(spinner)
        controls.addSubview(progress)
        timeLabel.font = Skin.text
        timeLabel.textColor = .white
        controls.addSubview(timeLabel)
        remainingLabel.font = Skin.text
        remainingLabel.textColor = .white
        remainingLabel.textAlignment = .right
        controls.addSubview(remainingLabel)
        chapterLabel.font = .systemFont(ofSize: 13, weight: .medium)
        chapterLabel.textColor = .white
        chapterLabel.lineBreakMode = .byTruncatingTail
        chapterLabel.layer.shadowColor = UIColor.black.cgColor
        chapterLabel.layer.shadowOpacity = 0.7
        chapterLabel.layer.shadowRadius = 2
        chapterLabel.layer.shadowOffset = CGSize(width: 0, height: 1)
        chapterLabel.isHidden = true
        controls.addSubview(chapterLabel)
        roster.isHidden = true
        controls.addSubview(roster)
        rosterLabel.isHidden = true
        controls.addSubview(rosterLabel)
        roster.configure(commands.thumbnails)
        commands.thumbnails?.onChange = { [weak self] in
            guard let self else { return }
            if let fraction = self.rosterFraction { self.updateRoster(fraction) }
            if self.rosterPinned { self.updatePinned() }
        }
        roster.onPan = { [weak self] dx, state in self?.pinPanned(dx, state) }
        roster.onTap = { [weak self] x in self?.pinTapped(x) }
        roster.onClose = { [weak self] in self?.closePin() }

        exitButton.layers = V10Icons.fullscreenExit
        exitButton.accessibilityLabel = texts.exitFullscreen
        pipButton.layers = V10Icons.pip
        pipButton.accessibilityLabel = texts.pictureInPicture
        audioButton.layers = V10Icons.language
        audioButton.accessibilityLabel = texts.audioMenu
        subtitlesButton.layers = V10Icons.captions
        subtitlesButton.accessibilityLabel = texts.subtitlesMenu
        rateButton.layers = V10Icons.speed
        rateButton.accessibilityLabel = texts.playbackRate
        rateButton.accessibilityValue = rateLabel(rate)
        browseButton.layers = BrowseIcons.list
        browseButton.accessibilityLabel = texts.browse
        browseButton.isHidden = browse == nil
        spinner.accessibilityLabel = texts.loading
        progress.accessibilityLabel = texts.seek

        on(playPause) { $0.state.playing ? $0.commands.pause() : $0.commands.play() }
        on(skipBack) { $0.skip(by: -Double($0.layout?.skipBack ?? 0)) }
        on(skipForward) { $0.skip(by: Double($0.layout?.skipForward ?? 0)) }
        on(exitButton) { $0.onLeave?() }
        on(pipButton) { $0.onPictureInPicture?() }
        on(muteButton) { $0.player.isMuted.toggle(); $0.refresh() }
        on(browseButton) { $0.panel == nil ? $0.openBrowse() : $0.closeBrowse() }
        on(rateButton, opensMenu: true) { $0.openMenu(from: $0.rateButton, title: $0.texts.playbackRate, items: $0.rateItems()) }
        on(audioButton, opensMenu: true) { $0.openMenu(from: $0.audioButton, title: $0.texts.audioMenu, items: $0.audioItems()) }
        on(subtitlesButton, opensMenu: true) { $0.openMenu(from: $0.subtitlesButton, title: $0.texts.subtitlesMenu, items: $0.subtitleItems()) }
        progress.onScrub = { [weak self] fraction, ended in self?.scrub(to: fraction, ended: ended) }

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = self
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.require(toFail: doubleTap)
        tap.delegate = self
        view.addGestureRecognizer(doubleTap)
        view.addGestureRecognizer(tap)

        visibility.onChange = { [weak self] visible in self?.showControls(visible) }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        observe()
        refresh()
    }

    /// Stops watching the player and hands it back; called as the presentation ends.
    func detach() {
        restorePortrait()
        stopObserving()
        visibility.stop()
        closeMenu()
        closePin()
        hideRoster()
        panel?.removeFromSuperview()
        panel = nil
        removeNextUp()
        commands.thumbnails?.onChange = nil
        videoView.playerLayer.player = nil
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        videoView.frame = view.bounds
        controls.frame = view.bounds
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let centre = CGPoint(x: area.midX, y: area.midY)
        let scale = Skin.scale(forWidth: area.width)
        // The fade covers the foot of the picture: the bottom row and the room the roster lifts into.
        let fadeHeight = min(view.bounds.height, (Skin.control + 120) * scale)
        fade.frame = CGRect(x: 0, y: view.bounds.height - fadeHeight, width: view.bounds.width, height: fadeHeight)

        playPause.frame = square(Skin.play * scale, at: centre)
        spinner.frame = playPause.frame
        skipBack.frame = square(Skin.skip * scale, at: CGPoint(x: centre.x - Skin.skipOffset * scale, y: centre.y - Skin.skipLift))
        skipForward.frame = square(Skin.skip * scale, at: CGPoint(x: centre.x + Skin.skipOffset * scale, y: centre.y - Skin.skipLift))

        // The top row, in `player-web`'s order, closing up around what is hidden.
        var x = area.minX
        for button in [audioButton, pipButton, airPlayButton, subtitlesButton, rateButton, muteButton, browseButton] as [UIView] where !button.isHidden {
            button.frame = CGRect(x: x, y: area.minY, width: Skin.control, height: Skin.control)
            x += Skin.control
        }

        exitButton.frame = CGRect(x: area.maxX - Skin.control, y: area.maxY - Skin.control, width: Skin.control, height: Skin.control)
        // The bottom row: what has played, the bar, what is left, then the exit button's corner.
        let rowMid = area.maxY - Skin.control / 2
        timeLabel.sizeToFit()
        remainingLabel.sizeToFit()
        let timeWidth = max(timeLabel.bounds.width, remainingLabel.bounds.width, 40 * scale)
        timeLabel.frame = CGRect(
            x: area.minX + 8, y: rowMid - timeLabel.bounds.height / 2, width: timeWidth, height: timeLabel.bounds.height
        )
        let barEnd = area.maxX - Skin.control
        let remainingWidth = remainingLabel.text?.isEmpty == false ? timeWidth : 0
        remainingLabel.frame = CGRect(
            x: barEnd - remainingWidth, y: rowMid - remainingLabel.bounds.height / 2,
            width: remainingWidth, height: remainingLabel.bounds.height
        )
        let barStart = timeLabel.text?.isEmpty == false ? timeLabel.frame.maxX + Skin.timeGap : area.minX + Skin.progressInset
        let barStop = remainingWidth > 0 ? remainingLabel.frame.minX - Skin.timeGap : barEnd
        progress.frame = CGRect(x: barStart, y: area.maxY - Skin.control, width: max(barStop - barStart, 0), height: Skin.control)
        progress.scale = scale
        // The chapter line sits just over the bar, from the time's edge to the bar's end.
        chapterLabel.font = .systemFont(ofSize: 13 * scale, weight: .medium)
        let chapterHeight = chapterLabel.font.lineHeight.rounded(.up)
        chapterLabel.frame = CGRect(
            x: area.minX + 8, y: progress.frame.midY - Skin.knob / 2 - 2 - chapterHeight,
            width: max(barStop - area.minX - 8, 0), height: chapterHeight
        )

        menu.map(place)
        panel?.frame = view.bounds
        placeNextUp(animated: false)
        if let fraction = rosterFraction { updateRoster(fraction) }
        if rosterPinned { updatePinned() }
    }

    private func square(_ side: CGFloat, at centre: CGPoint) -> CGRect {
        CGRect(x: centre.x - side / 2, y: centre.y - side / 2, width: side, height: side)
    }

    // MARK: State

    private func observe() {
        guard timeObserver == nil else { return }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            self?.refresh()
        }
        // Looking for devices costs battery, so only while this view is up.
        routeDetector.isRouteDetectionEnabled = true
        routeObservation = routeDetector.observe(\.multipleRoutesDetected) { [weak self] _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        observations = [
            player.observe(\.isExternalPlaybackActive) { [weak self] _, _ in DispatchQueue.main.async { self?.refresh() } },
            player.observe(\.timeControlStatus) { [weak self] _, _ in DispatchQueue.main.async { self?.refresh() } },
            player.observe(\.rate) { [weak self] player, _ in
                DispatchQueue.main.async {
                    if player.rate > 0 { self?.rate = roundedRate(Double(player.rate)) }
                    self?.refresh()
                }
            },
            player.observe(\.currentItem, options: [.initial, .new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.itemChanged() }
            },
        ]
    }

    /// A reattach or a load gives the player a new item, whose subtitles are its own.
    private func itemChanged() {
        guard subtitles?.item !== player.currentItem else { return }
        closePin()
        subtitles = nil
        if menu?.tag == subtitlesButton.hash { closeMenu() }
        loadSubtitles()
        refresh()
    }

    private func stopObserving() {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        observations.forEach { $0.invalidate() }
        observations = []
        routeObservation?.invalidate()
        routeObservation = nil
        routeDetector.isRouteDetectionEnabled = false
    }

    /// Reads the player and the engine, and draws what the layout says.
    private func refresh() {
        guard isViewLoaded else { return }
        let item = player.currentItem
        let duration = item?.duration ?? .invalid
        var next = FullscreenControlsState()
        next.playing = commands.playbackWanted()
        next.waiting = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
        next.live = duration.isIndefinite
        next.awaitingDuration = !duration.isIndefinite && !(duration.isNumeric && duration.seconds > 0)
        next.duration = duration.isNumeric ? duration.seconds : 0
        let position = player.currentTime().seconds
        playhead = position.isFinite ? position : 0
        next.position = scrubbing ?? playhead
        next.loadedEnd = loadedEnd(item, at: next.position)
        next.rate = rate
        next.muted = player.isMuted
        next.audioTrackCount = commands.audioTracks().tracks.count
        next.hasSubtitles = subtitles?.options.isEmpty == false
        state = next

        let layout = FullscreenControlsLayout(next, skin: commands.skin)
        let rowChanged = self.layout.map { $0.showsAudioMenu != layout.showsAudioMenu
            || $0.showsSubtitlesMenu != layout.showsSubtitlesMenu || $0.showsRate != layout.showsRate } ?? true
        self.layout = layout

        playPause.layers = layout.showsPause ? V10Icons.pause : V10Icons.play
        playPause.accessibilityLabel = layout.showsPause ? texts.pause : texts.play
        playPause.isHidden = layout.showsSpinner
        spinner.isHidden = !layout.showsSpinner
        skipBack.isHidden = layout.skipBack == nil
        skipBack.skip = layout.skipBack.map { ($0, false) }
        skipBack.accessibilityLabel = layout.skipBack.map(texts.skipBack)
        skipForward.isHidden = layout.skipForward == nil
        skipForward.skip = layout.skipForward.map { ($0, true) }
        skipForward.accessibilityLabel = layout.skipForward.map(texts.skipForward)
        audioButton.isHidden = !layout.showsAudioMenu
        subtitlesButton.isHidden = !layout.showsSubtitlesMenu
        pipButton.isHidden = !pictureInPictureAvailable
        airPlayButton.isHidden = !routeDetector.multipleRoutesDetected && !player.isExternalPlaybackActive
        rateButton.isHidden = !layout.showsRate
        rateButton.accessibilityValue = rateLabel(next.rate)
        muteButton.layers = next.muted ? V10Icons.volumeOff : V10Icons.volumeHigh
        muteButton.accessibilityLabel = next.muted ? texts.unmute : texts.mute

        progress.isHidden = !layout.showsProgress
        if layout.showsProgress, next.duration > 0 {
            progress.update(played: next.position / next.duration, loaded: next.loadedEnd / next.duration)
            progress.accessibilityValue = timeText(next)
        }
        // While the finger is on the bar the times follow it, as the roster's label does.
        var shown = next
        if let held = scrubbing { shown.position = held }
        let (elapsed, remaining) = timeTexts(shown)
        if timeLabel.text != elapsed || remainingLabel.text != remaining {
            timeLabel.text = elapsed
            remainingLabel.text = remaining
            view.setNeedsLayout()
        }
        if rowChanged { view.setNeedsLayout() }
        showChapter(layout.showsProgress ? next.duration : 0)
        updateNextUp()
        panel?.markChapter(browse?.chapterIndex(at: playhead))
        visibility.playbackChanged(playing: next.playing)
    }

    private func loadedEnd(_ item: AVPlayerItem?, at position: Double) -> Double {
        guard let ranges = item?.loadedTimeRanges.map(\.timeRangeValue) else { return 0 }
        let containing = ranges.first { $0.start.seconds <= position + 0.5 && position <= $0.end.seconds + 0.5 }
        return containing?.end.seconds ?? 0
    }

    // MARK: Actions

    /// Every control's action also keeps the controls up for another 3 s, and closes an open menu,
    /// as video.js does when focus leaves it; the buttons that open a menu decide that themselves.
    private func on(_ button: UIControl, opensMenu: Bool = false, _ action: @escaping (FullscreenViewController) -> Void) {
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.visibility.touched()
            if !opensMenu { self.closeMenu() }
            action(self)
        }, for: .touchUpInside)
    }

    private func skip(by seconds: Double) {
        let target = state.position + seconds
        commands.seek(min(max(target, 0), state.duration > 0 ? state.duration : target))
    }

    private func scrub(to fraction: Double, ended: Bool) {
        visibility.touched()
        guard state.duration > 0 else { return }
        let position = min(max(fraction, 0), 1) * state.duration
        if ended {
            scrubbing = nil
            // A roster the press had open stays open, centred on where the video is going.
            let held = rosterFraction != nil && commands.thumbnails?.ready == true
            hideRoster()
            commands.seek(position)
            if held { openPin(at: position) }
        } else {
            scrubbing = position
            if rosterPinned { closePin() }
            if commands.thumbnails?.ready == true { updateRoster(fraction) }
        }
        refresh()
    }

    // MARK: Roster

    /// The frame the web's hover preview shows: a sixth of the width, 16:9.
    private func rosterHeight(_ width: CGFloat) -> CGFloat {
        min(340, max(168, width / 6)) * 9 / 16
    }

    private func updateRoster(_ fraction: Double) {
        guard state.duration > 0 else { return }
        let fraction = min(max(fraction, 0), 1)
        rosterFraction = fraction
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let height = rosterHeight(area.width)
        // The strip rests on the bottom row, the whole width of the safe area.
        roster.frame = CGRect(x: area.minX, y: area.maxY - Skin.control - height, width: area.width, height: height)
        let markerX = progress.frame.minX + CGFloat(fraction) * progress.frame.width - roster.frame.minX
        let time = fraction * state.duration
        roster.show(time: time, markerX: min(max(markerX, 0), roster.frame.width), duration: state.duration)
        roster.isHidden = false
        rosterLabel.text = formatTime(time, guide: state.duration)
        rosterLabel.sizeToFit()
        let half = rosterLabel.bounds.width / 2
        let centre = min(max(roster.frame.minX + markerX, area.minX + half + 8), area.maxX - half - 8)
        rosterLabel.frame = CGRect(
            x: centre - half, y: roster.frame.minY - rosterLabel.bounds.height - 6,
            width: rosterLabel.bounds.width, height: rosterLabel.bounds.height
        )
        rosterLabel.isHidden = false
    }

    private func hideRoster() {
        rosterFraction = nil
        roster.isHidden = true
        rosterLabel.isHidden = true
    }

    // MARK: Pinned roster

    private func openPin(at time: Double) {
        guard state.duration > 0, commands.thumbnails?.ready == true else { return }
        rosterPinned = true
        visibility.pinned = true
        roster.setInteractive(true, closeLabel: texts.closeRoster)
        rest(at: time)
        pinLink?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(pinTick))
        link.add(to: .main, forMode: .common)
        pinLink = link
        updatePinned()
    }

    private func closePin() {
        guard rosterPinned else { return }
        rosterPinned = false
        pinLink?.invalidate()
        pinLink = nil
        pinDrag = nil
        pinAnchor = nil
        pinAnchorTimeout?.cancel()
        roster.setInteractive(false)
        hideRoster()
        visibility.pinned = false
    }

    /// Keeps the strip at `time` while the video gets there.
    private func rest(at time: Double) {
        pinAnchor = time
        pinAnchorTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in self?.pinAnchor = nil }
        pinAnchorTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timeout)
    }

    /// Where the strip is: under the finger while it is dragged, else where the video is going, else the playhead.
    private var pinTime: Double {
        let now = player.currentTime().seconds
        return pinDrag?.time ?? pinAnchor ?? (now.isFinite ? now : 0)
    }

    @objc private func pinTick() {
        // The strip glides with the playhead, read every frame: the periodic observer is a few times a second.
        if let anchor = pinAnchor, abs(player.currentTime().seconds - anchor) < 0.75 { pinAnchor = nil }
        updatePinned()
    }

    private func updatePinned() {
        guard rosterPinned, state.duration > 0 else { return }
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let height = rosterHeight(area.width)
        roster.frame = CGRect(x: area.minX, y: area.maxY - Skin.control - height, width: area.width, height: height)
        let markerX = roster.frame.width / 2
        let time = min(max(pinTime, 0), state.duration)
        roster.show(time: time, markerX: markerX, duration: state.duration, step: Roster.fineStep(duration: state.duration))
        roster.isHidden = false
        rosterLabel.text = formatTime(time, guide: state.duration)
        rosterLabel.sizeToFit()
        let half = rosterLabel.bounds.width / 2
        rosterLabel.frame = CGRect(
            x: roster.frame.midX - half, y: roster.frame.minY - rosterLabel.bounds.height - 6,
            width: rosterLabel.bounds.width, height: rosterLabel.bounds.height
        )
        rosterLabel.isHidden = false
    }

    private func pinPanned(_ dx: CGFloat, _ gesture: UIGestureRecognizer.State) {
        guard rosterPinned, state.duration > 0,
              let perSecond = roster.pointsPerSecond(step: Roster.fineStep(duration: state.duration)) else { return }
        visibility.touched()
        switch gesture {
        case .began:
            pinDrag = (pinTime, pinTime, false)
        case .changed:
            guard let drag = pinDrag else { return }
            // The strip follows the finger, so a drag to the right is back in time.
            let time = Roster.timeAfterDrag(
                startTime: drag.startTime, dx: Double(dx), pointsPerSecond: Double(perSecond), duration: state.duration
            )
            pinDrag = (drag.startTime, time, drag.moved || abs(dx) > 4)
        case .ended:
            guard let drag = pinDrag else { return }
            pinDrag = nil
            if drag.moved {
                rest(at: drag.time)
                commands.seek(drag.time)
            }
        default:
            pinDrag = nil
        }
        updatePinned()
    }

    private func pinTapped(_ x: CGFloat) {
        guard rosterPinned, state.duration > 0,
              let perSecond = roster.pointsPerSecond(step: Roster.fineStep(duration: state.duration)) else { return }
        visibility.touched()
        let target = Roster.timeAtTap(
            time: pinTime, x: Double(x), markerX: Double(roster.frame.width / 2),
            pointsPerSecond: Double(perSecond), duration: state.duration
        )
        rest(at: target)
        commands.seek(target)
        updatePinned()
    }

    @objc private func tapped() {
        if menu != nil {
            closeMenu()
            visibility.touched()
            return
        }
        visibility.tappedPicture()
    }

    @objc private func doubleTapped() {
        onLeave?()
    }

    /// Taps on a control, the bar or a menu are theirs, not the picture's.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view, current !== self.view {
            if current is UIControl || current === progress || current === roster || current is FullscreenMenu
                || current is BrowsePanel || current is NextUpStrip { return false }
            view = current.superview
        }
        return true
    }

    private func showControls(_ visible: Bool) {
        if !visible { closeMenu() }
        controls.isUserInteractionEnabled = visible
        UIView.animate(withDuration: visible ? Skin.showDuration : Skin.hideDuration) {
            self.controls.alpha = visible ? 1 : 0
        }
        placeNextUp(animated: true)
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
    }

    // MARK: Chapters and up next

    /// "Chapter 4 of 7" over the bar, and the bar cut at the chapter starts, as the web player does.
    private func showChapter(_ duration: Double) {
        let chapters = browse?.chapters ?? []
        progress.cuts = ChapterCuts.starts(chapters, duration: duration)
        let text = duration > 0 ? ChapterCuts.nowText(texts.chapterOf, chapters: chapters, index: browse?.chapterIndex(at: playhead)) : ""
        if chapterLabel.text != text { chapterLabel.text = text }
        chapterLabel.isHidden = text.isEmpty
        // Held, the bar and the frames carry the moment; the line would stack on them.
        chapterLabel.alpha = scrubbing != nil || !roster.isHidden ? 0 : 1
    }

    /// Replaces what the panel and the strip offer, also while the panel is open; with nothing to list the button
    /// goes and the panel closes.
    func setBrowse(_ next: Browse?) {
        // A different offer is a different video's: its strip opens again.
        let offer = Array((next?.nextUp ?? []).prefix(NextUp.max))
        if offer.map(\.id) != nextUpItems.map(\.id) {
            nextUpClosed = false
            removeNextUp()
        }
        nextUpItems = offer
        browse = next.flatMap { $0.isEmpty ? nil : $0 }
        guard isViewLoaded else { return }
        browseButton.isHidden = browse == nil
        view.setNeedsLayout()
        if let panel {
            if let browse {
                panel.show(browse, texts: texts, chapter: browse.chapterIndex(at: playhead), duration: state.duration, scale: currentScale, keepScroll: true)
            } else {
                closeBrowse()
            }
        }
        refresh()
    }

    private var currentScale: CGFloat { Skin.scale(forWidth: view.bounds.inset(by: view.safeAreaInsets).width) }

    private func openBrowse() {
        guard let browse, panel == nil else { return }
        closeMenu()
        closePin()
        hideRoster()
        let panel = BrowsePanel(frame: view.bounds)
        panel.onClose = { [weak self] in self?.closeBrowse() }
        panel.onChapter = { [weak self] chapter in
            guard let self else { return }
            (self.commands.seekExactly ?? self.commands.seek)(chapter.start)
            self.closeBrowse()
        }
        panel.onUpNext = { [weak self] id in
            self?.commands.selectUpNext(id)
            self?.closeBrowse()
        }
        view.addSubview(panel)
        self.panel = panel
        panel.show(browse, texts: texts, chapter: browse.chapterIndex(at: playhead), duration: state.duration, scale: currentScale, keepScroll: false)
        // The controls stay under the panel, whatever playback does, until it is put away.
        visibility.pinned = true
        updateNextUp()
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    private func closeBrowse() {
        guard let panel else { return }
        panel.removeFromSuperview()
        self.panel = nil
        visibility.pinned = false
        updateNextUp()
        UIAccessibility.post(notification: .screenChanged, argument: browseButton)
    }

    /// Opens or puts away the strip as the playhead and the panel say; called as the state changes.
    private func updateNextUp() {
        let due = panel == nil && NextUp.due(
            offered: !nextUpItems.isEmpty, closed: nextUpClosed, live: state.live,
            duration: state.duration > 0 ? state.duration : nil, position: playhead
        )
        guard due != (nextUpStrip != nil) else { return }
        due ? showNextUp() : removeNextUp()
    }

    private func showNextUp() {
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let strip = NextUpStrip(items: nextUpItems, texts: texts, cardHeight: rosterHeight(area.width), scale: currentScale)
        strip.onPick = { [weak self] id in self?.chooseNextUp(id) }
        strip.onClose = { [weak self] in self?.closeNextUp() }
        // Over the controls, under the panel.
        view.insertSubview(strip, aboveSubview: controls)
        nextUpStrip = strip
        placeNextUp(animated: false)
        strip.alpha = 0
        UIView.animate(withDuration: BrowseSkin.stripDuration) { strip.alpha = 1 }
    }

    private func removeNextUp() {
        nextUpStrip?.takeDown()
        nextUpStrip = nil
    }

    private func closeNextUp() {
        guard !nextUpClosed else { return }
        nextUpClosed = true
        removeNextUp()
        commands.nextUp(nil)
    }

    private func chooseNextUp(_ id: String) {
        guard !nextUpClosed else { return }
        nextUpClosed = true
        removeNextUp()
        commands.nextUp(id)
    }

    /// Directly over the bar (and the chapter line over it) while the controls show, on the bottom edge when they
    /// do not. When that would put it over the play and skip buttons it is held to the right of them instead,
    /// which is as far as it need give way: the cards scroll.
    private func placeNextUp(animated: Bool) {
        guard let strip = nextUpStrip else { return }
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let height = strip.preferredHeight
        let shown = visibility.visible
        let bottom: CGFloat
        if shown {
            bottom = (chapterLabel.isHidden ? progress.frame.midY - Skin.knob / 2 : chapterLabel.frame.minY) - 8
        } else {
            bottom = area.maxY - 16
        }
        var start = area.minX + 8
        let cluster = [skipBack, playPause, spinner, skipForward].filter { !$0.isHidden }
        if shown, let lowest = cluster.map(\.frame.maxY).max(), let rightmost = cluster.map(\.frame.maxX).max(),
           bottom - height < lowest + 8 {
            start = max(start, rightmost + 8)
        }
        let frame = CGRect(x: start, y: bottom - height, width: max(area.maxX - 8 - start, 0), height: height)
        guard strip.frame != frame else { return }
        if animated {
            UIView.animate(withDuration: BrowseSkin.stripDuration) {
                strip.frame = frame
                strip.layoutIfNeeded()
            }
        } else {
            strip.frame = frame
        }
    }

    // MARK: Menus

    private func rateItems() -> [FullscreenMenu.Item] {
        // Fastest first, as video.js lists them.
        fullscreenRates.reversed().map { rate in
            .init(title: rateLabel(rate), selected: rate == state.rate) { [weak self] in
                self?.rate = rate
                self?.commands.setRate(rate)
                self?.closeMenu()
                self?.refresh()
            }
        }
    }

    private func audioItems() -> [FullscreenMenu.Item] {
        let (tracks, activeId) = commands.audioTracks()
        return tracks.map { track in
            .init(title: track.label, selected: track.id == activeId) { [weak self] in
                self?.commands.setAudioTrack(track.id)
                self?.closeMenu()
            }
        }
    }

    private func subtitleItems() -> [FullscreenMenu.Item] {
        guard let subtitles, subtitles.item === player.currentItem else { return [] }
        let item = subtitles.item
        let selected = item.currentMediaSelection.selectedMediaOption(in: subtitles.group)
        let off = FullscreenMenu.Item(title: texts.subtitlesOff, selected: selected == nil) { [weak self] in
            item.select(nil, in: subtitles.group)
            self?.closeMenu()
        }
        return [off] + subtitles.options.map { option in
            .init(title: option.playlistName, selected: option == selected) { [weak self] in
                item.select(option, in: subtitles.group)
                self?.closeMenu()
            }
        }
    }

    private func openMenu(from button: UIView, title: String, items: [FullscreenMenu.Item]) {
        let reopen = menu?.tag != button.hash
        closeMenu()
        guard reopen, !items.isEmpty else { return }
        // A pick is a touch like any other: the controls stay another 3 s, then hide.
        let menu = FullscreenMenu(title: title, items: items.map { item in
            .init(title: item.title, selected: item.selected) { [weak self] in
                item.pick()
                self?.visibility.touched()
            }
        })
        menu.tag = button.hash
        self.menu = menu
        controls.addSubview(menu)
        place(menu)
        visibility.hold()
    }

    /// Beside its button, a little down, as video.js opens it; kept on screen.
    private func place(_ menu: FullscreenMenu) {
        guard let button = [audioButton, pipButton, subtitlesButton, rateButton, muteButton].first(where: { $0.hash == menu.tag }) else { return }
        var frame = menu.bounds
        frame.origin = CGPoint(x: button.frame.minX + Skin.control, y: button.frame.minY + 16)
        frame.origin.y = min(frame.origin.y, view.bounds.maxY - frame.height - 8)
        menu.frame = frame
    }

    private func closeMenu() {
        menu?.removeFromSuperview()
        menu = nil
    }

    // MARK: Subtitles

    /// The item's own subtitles, the ones a viewer can choose: not forced-only tracks. Kept with
    /// the item they belong to, so a group is never applied to an item it was not read from.
    private func loadSubtitles() {
        guard let item = player.currentItem else { return }
        Task { @MainActor [weak self] in
            guard let group = try? await item.asset.loadMediaSelectionGroup(for: .legible),
                  let self, self.player.currentItem === item else { return }
            let options = group.options.filter { !$0.hasMediaCharacteristic(.containsOnlyForcedSubtitles) }
            self.subtitles = (item, group, options)
            self.refresh()
        }
    }
}

/// The progress bar: a 4 pt rounded track, what is loaded, what is played and a knob, cut at the
/// chapter starts. Dragging or tapping it seeks.
final class ProgressBar: UIView {
    /// The fraction the viewer points at, and whether they let go.
    var onScrub: ((Double, Bool) -> Void)?
    /// Where each chapter after the first starts, as a fraction of the bar: ``ChapterCuts/starts(_:duration:)``.
    var cuts: [Double] = [] {
        didSet { if cuts != oldValue { setNeedsLayout() } }
    }
    /// The skin's scale, which the gaps between chapters grow with.
    var scale: CGFloat = 1 {
        didSet { if scale != oldValue { setNeedsLayout() } }
    }

    /// The three bars, masked together so a cut goes through all of them; the knob stays whole.
    private let bars = UIView()
    private let cutMask = CAShapeLayer()
    private let track = UIView()
    private let loaded = UIView()
    private let played = UIView()
    private let knob = UIView()
    private var playedFraction: Double = 0
    private var loadedFraction: Double = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        track.backgroundColor = Skin.progressTrack
        loaded.backgroundColor = Skin.progressLoaded
        played.backgroundColor = .white
        knob.backgroundColor = .white
        bars.isUserInteractionEnabled = false
        addSubview(bars)
        for part in [track, loaded, played] {
            part.isUserInteractionEnabled = false
            bars.addSubview(part)
        }
        cutMask.fillRule = .evenOdd
        knob.isUserInteractionEnabled = false
        addSubview(knob)
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(panned)))
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func update(played: Double, loaded: Double) {
        playedFraction = min(max(played, 0), 1)
        loadedFraction = min(max(loaded, 0), 1)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        bars.frame = bounds
        let y = (bounds.height - Skin.progressHeight) / 2
        let radius = Skin.progressHeight / 2
        if cuts.isEmpty {
            bars.layer.mask = nil
        } else {
            // Everything, less a thin gap at each cut: even-odd leaves the gaps out.
            let path = UIBezierPath(rect: bounds)
            let half = CGFloat(ChapterCuts.halfGap(stretches: cuts.count + 1)) * scale
            for cut in cuts {
                path.append(UIBezierPath(rect: CGRect(x: bounds.width * CGFloat(cut) - half, y: 0, width: 2 * half, height: bounds.height)))
            }
            cutMask.frame = bounds
            cutMask.path = path.cgPath
            bars.layer.mask = cutMask
        }
        track.frame = CGRect(x: 0, y: y, width: bounds.width, height: Skin.progressHeight)
        loaded.frame = CGRect(x: 0, y: y, width: bounds.width * loadedFraction, height: Skin.progressHeight)
        played.frame = CGRect(x: 0, y: y, width: bounds.width * playedFraction, height: Skin.progressHeight)
        for part in [track, loaded, played] { part.layer.cornerRadius = radius }
        knob.frame = CGRect(
            x: bounds.width * playedFraction - Skin.knob / 2, y: bounds.midY - Skin.knob / 2,
            width: Skin.knob, height: Skin.knob
        )
        knob.layer.cornerRadius = Skin.knob / 2
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let fraction = Double(pan.location(in: self).x / max(bounds.width, 1))
        switch pan.state {
        case .began, .changed: onScrub?(fraction, false)
        case .ended, .cancelled: onScrub?(fraction, true)
        default: break
        }
    }

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        onScrub?(Double(tap.location(in: self).x / max(bounds.width, 1)), true)
    }

    override func accessibilityIncrement() {
        onScrub?(playedFraction + 0.05, true)
    }

    override func accessibilityDecrement() {
        onScrub?(playedFraction - 0.05, true)
    }
}
#endif

#if canImport(UIKit)
/// The system's device list is a sheet over this view: the controls stay while it is up, and run
/// their timer again once it is gone.
extension FullscreenViewController: AVRoutePickerViewDelegate {
    func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) {
        visibility.hold()
    }

    func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
        visibility.touched()
    }
}
#endif
