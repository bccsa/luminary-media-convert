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

/// Native full-screen, drawn to the Video.js 10 skin as Android's is (plan 05): play/pause and the
/// skips in the middle; under them the timeline, with the time played before it and the time left
/// after it; and under that one row of buttons, the settings at the left and AirPlay, picture in
/// picture and leaving at the right, all on a fade rising from the bottom edge. ``FullscreenControlsLayout`` and
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
    private let scrubPicture = ScrubPictureView()
    /// The subtitles, drawn here rather than by the player: over the picture's foot, lifted over the timeline while
    /// the controls show.
    private let subtitleLabel = SubtitleLabel()
    private var subtitleWatch: UUID?
    private let playPause = GlyphButton(size: Skin.play, iconSize: Skin.playIcon, circle: true)
    private let spinner = SpinnerView()
    private let skipBack = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon, circle: true)
    private let skipForward = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon, circle: true)
    private let audioButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let pipButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let subtitlesButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let qualityButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    /// The heights the item's variants offer, read once per item; none hides the menu.
    private var qualities: (item: AVPlayerItem, heights: [Int])?
    /// The height the viewer chose in this menu, kept for the next video while full-screen stays open; nil is auto.
    private var heldHeight: Int?
    private let rateButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let muteButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let exitButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    private let browseButton = GlyphButton(size: Skin.rowButton, iconSize: Skin.icon)
    /// Apple's own AirPlay control: it draws the glyph, shows casting in its tint, and opens the
    /// system's device list. Hidden unless the detector finds a device to send to.
    private let airPlayButton = AVRoutePickerView()
    private let routeDetector = AVRouteDetector()
    private var routeObservation: NSKeyValueObservation?
    private let progress = ProgressBar()
    private let timeLabel = UILabel()
    private let remainingLabel = UILabel()
    private let fade = FadeView()
    /// The top line: what plays at the left, leaving full-screen at the right, over a fade from the top edge.
    private let topFade = FadeView(fromTop: true)
    private let headingTitle = UILabel()
    private let headingSubtitle = UILabel()
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
    /// The roster is pinned: left open after the finger lifted, following the playhead, and dragged on its own
    /// for the slow, precise way through the video (the bar is the fast one).
    private var rosterPinned = false
    private var pinDrag: (startTime: Double, time: Double, moved: Bool)?
    /// Where the pinned strip's marker stays: where the finger lifted off the timeline, in the strip's coordinates.
    private var pinMarkerX: CGFloat = 0
    /// Where the strip rests after a seek, until playback has caught up; else it snaps back to the old time.
    private var pinAnchor: Double?
    private var pinAnchorTimeout: DispatchWorkItem?
    private var pinLink: CADisplayLink?
    /// Where the timeline's row ends while the frames are down: they rise from the bottom edge to it.
    private var rowRest: CGFloat = 0
    /// The frames last laid out as up or down.
    private var rosterWasUp = false
    /// Playback paused for a scrub, to start again when the finger lifts: a playhead that keeps moving under the
    /// finger makes the frames drift and the landing a guess.
    private var resumeAfterScrub = false
    /// The time left reads as the whole length instead, as the web's does when pressed.
    private var showTotal = false

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

    /// A landscape picture on a phone stays sideways for as long as full-screen is up, either way
    /// round; turning the phone upright leaves (`watchDevice`). Elsewhere full-screen follows the
    /// device, as the app allows.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        holdsLandscape ? .landscape : UIApplication.shared.supportedInterfaceOrientations(for: view.window)
    }

    /// Full-screen starts the way the phone is held when it is on its side. A device's landscape-left
    /// is the interface's landscape-right.
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        switch UIDevice.current.orientation {
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        default: return holdsLandscape ? .landscapeRight : super.preferredInterfaceOrientationForPresentation
        }
    }

    /// The picture is wider than tall. Known once the item has a size.
    private var videoIsLandscape: Bool {
        guard let size = player.currentItem?.presentationSize, size.width > 0, size.height > 0 else { return false }
        return size.width > size.height
    }

    /// Before the size is known the picture counts as landscape: a portrait one is let go of once
    /// its size is known.
    private var videoIsUpright: Bool {
        guard let size = player.currentItem?.presentationSize, size.width > 0, size.height > 0 else { return false }
        return size.height > size.width
    }

    private var holdsLandscape: Bool { UIDevice.current.userInterfaceIdiom == .phone && !videoIsUpright }

    /// A video was picked to play next: the spinner shows from the tap until it plays, as the page prepares it.
    private var switching: DispatchWorkItem?
    /// The item that was showing at the pick: the spinner goes once another one plays.
    private weak var switchingFrom: AVPlayerItem?
    /// Long enough for the page to fetch the next video's key and load it; past it, the controls show again.
    private static let switchingLimit: TimeInterval = 15

    private var exit = UprightExit()
    private var deviceObserver: NSObjectProtocol?
    private var leaving: DispatchWorkItem?
    private var turned = false
    private weak var scene: UIWindowScene?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        scene = view.window?.windowScene
        guard holdsLandscape else { return }
        watchDevice()
        turnToLandscape()
    }

    /// Opened from a phone held upright: full-screen turns sideways itself, as the viewer asked for
    /// the picture to fill the screen. iOS 15 cannot be asked, and turns as the mask allows.
    private func turnToLandscape() {
        guard let scene, scene.interfaceOrientation.isPortrait else { return }
        turned = true
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape)) { _ in }
        }
    }

    /// The phone's own position, read while full-screen is held sideways: once it has been on its
    /// side, holding it upright for a moment leaves. The viewer's rotation lock silences it, which
    /// leaves the exit button.
    private func watchDevice() {
        guard deviceObserver == nil else { return }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        _ = exit.saw(PhonePose.current)
        deviceObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.deviceTurned() }
    }

    private func deviceTurned() {
        let pose = PhonePose.current
        // Flat or unknown says nothing: a phone laid down after turning it upright still leaves.
        guard let pose else { return }
        guard exit.saw(pose) else {
            leaving?.cancel()
            leaving = nil
            return
        }
        guard leaving == nil else { return }
        let leave = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.leaving = nil
            guard PhonePose.current != .sideways else { return }
            self.onLeave?()
        }
        leaving = leave
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.uprightSettle, execute: leave)
    }

    /// Long enough to pass a wobble, short enough to feel like the system's own turn.
    private static let uprightSettle: TimeInterval = 0.25

    private func stopWatchingDevice() {
        leaving?.cancel()
        leaving = nil
        guard let deviceObserver else { return }
        NotificationCenter.default.removeObserver(deviceObserver)
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        self.deviceObserver = nil
    }

    deinit {
        leaving?.cancel()
        if let deviceObserver {
            NotificationCenter.default.removeObserver(deviceObserver)
            UIDevice.current.endGeneratingDeviceOrientationNotifications()
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
        // Where the interface follows the device (an iPad), turning a landscape picture upright
        // leaves.
        guard !holdsLandscape, videoIsLandscape, size.height > size.width else { return }
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.onLeave?() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.playerLayer.videoGravity = .resizeAspect
        view.addSubview(videoView)

        // Under the controls, so a menu or the panel covers the words rather than the other way round.
        view.addSubview(subtitleLabel)
        subtitleWatch = LegibleText.of(player).observe { [weak self] lines in
            guard let self else { return }
            self.subtitleLabel.text = lines
            self.subtitleLabel.isHidden = lines.isEmpty
            self.view.setNeedsLayout()
        }

        // Over the picture and its words while the timeline is held, under the controls and the strip.
        view.addSubview(scrubPicture)
        controls.backgroundColor = .clear
        view.addSubview(controls)
        controls.addSubview(fade)
        controls.addSubview(topFade)
        for label in [headingTitle, headingSubtitle] {
            label.numberOfLines = 1
            label.lineBreakMode = .byTruncatingTail
            label.layer.shadowColor = UIColor.black.cgColor
            label.layer.shadowOpacity = 0.7
            label.layer.shadowRadius = 2
            label.layer.shadowOffset = CGSize(width: 0, height: 1)
            controls.addSubview(label)
        }
        headingTitle.textColor = .white
        headingSubtitle.textColor = UIColor(white: 1, alpha: 0.6)
        setHeading(title: commands.title, subtitle: commands.subtitle)
        for button in [playPause, skipBack, skipForward, audioButton, pipButton, subtitlesButton, qualityButton, rateButton, muteButton, browseButton, exitButton] {
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
        remainingLabel.isUserInteractionEnabled = true
        remainingLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleTotal)))
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
            // A sheet arrived: the frame held up over the picture can be drawn now.
            if !self.scrubPicture.isHidden { self.scrubPicture.setNeedsDisplay() }
            if let fraction = self.rosterFraction { self.updateRoster(fraction) }
            if self.rosterPinned { self.updatePinned() }
        }
        roster.onPan = { [weak self] dx, state in self?.pinPanned(dx, state) }

        exitButton.layers = BrowseIcons.close
        exitButton.accessibilityLabel = texts.exitFullscreen
        pipButton.layers = V10Icons.pip
        pipButton.accessibilityLabel = texts.pictureInPicture
        audioButton.layers = PlayerIcons.audioLanguage
        audioButton.accessibilityLabel = texts.audioMenu
        subtitlesButton.layers = PlayerIcons.captionsCc
        subtitlesButton.accessibilityLabel = texts.subtitlesMenu
        qualityButton.layers = V10Icons.quality
        qualityButton.accessibilityLabel = texts.qualityMenu
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
        on(qualityButton, opensMenu: true) { $0.openMenu(from: $0.qualityButton, title: $0.texts.qualityMenu, items: $0.qualityItems()) }
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
        switching?.cancel()
        switching = nil
        LegibleText.of(player).stopObserving(subtitleWatch)
        subtitleWatch = nil
        stopWatchingDevice()
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
        scrubPicture.frame = view.bounds
        controls.frame = view.bounds
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let centre = CGPoint(x: area.midX, y: area.midY)
        let scale = Skin.scale(forWidth: area.width)
        let edge = Skin.edge(forWidth: view.bounds.width)

        playPause.frame = square(Skin.play * scale, at: centre)
        spinner.frame = playPause.frame
        skipBack.frame = square(Skin.skip * scale, at: CGPoint(x: centre.x - Skin.skipOffset * scale, y: centre.y - Skin.skipLift))
        skipForward.frame = square(Skin.skip * scale, at: CGPoint(x: centre.x + Skin.skipOffset * scale, y: centre.y - Skin.skipLift))

        // One row of buttons along the bottom: the settings at the left, AirPlay, picture in picture and leaving at
        // the right, closing up around what is hidden. Their own padding keeps the glyphs on the line of the
        // timeline's ends.
        let side = Skin.rowButton * scale
        let rowY = area.maxY - Skin.columnBottom * scale - side
        var left = area.minX + edge - 8 * scale
        for button in [muteButton, qualityButton, audioButton, rateButton, subtitlesButton, browseButton] as [UIView] where !button.isHidden {
            button.frame = CGRect(x: left + 1, y: rowY, width: side, height: side)
            left += side + 2
        }
        var right = area.maxX - edge + 8 * scale
        for button in [pipButton, airPlayButton] as [UIView] where !button.isHidden {
            right -= side + 2
            button.frame = CGRect(x: right + 1, y: rowY, width: side, height: side)
        }

        // Over the buttons, the timeline between the time played and the time left. It lifts onto the frames
        // while they are up, the track resting on their top edge.
        rowRest = rowY
        let rowHeight = Skin.timelineRow * scale
        let restingY = rowY - rowHeight
        let timelineY = restingY - (rosterUp ? rosterHeight(area.width) - Skin.trackInset * scale : 0)
        for label in [timeLabel, remainingLabel] {
            label.font = .monospacedDigitSystemFont(ofSize: 13 * scale, weight: .medium)
            label.sizeToFit()
        }
        let elapsedWidth = max(timeLabel.bounds.width, 40 * scale)
        let remainingWidth = max(remainingLabel.bounds.width, 40 * scale)
        timeLabel.frame = CGRect(x: area.minX + edge, y: timelineY, width: elapsedWidth, height: rowHeight)
        remainingLabel.frame = CGRect(x: area.maxX - edge - remainingWidth, y: timelineY, width: remainingWidth, height: rowHeight)
        let gap = Skin.timeGap * scale
        progress.frame = CGRect(
            x: timeLabel.frame.maxX + gap, y: timelineY,
            width: max(remainingLabel.frame.minX - gap - timeLabel.frame.maxX - gap, 0), height: rowHeight
        )
        progress.scale = scale
        // The chapter line sits just over the timeline, the width of the column.
        chapterLabel.font = .systemFont(ofSize: 13 * scale, weight: .medium)
        let chapterHeight = chapterLabel.font.lineHeight.rounded(.up)
        chapterLabel.frame = CGRect(
            x: area.minX + edge, y: timelineY - 2 * scale - chapterHeight, width: max(area.width - 2 * edge, 0), height: chapterHeight
        )
        placeSubtitles(controlsShown: visibility.visible)
        // The fade rises from the bottom edge to the top of the column, so white controls read over a bright picture.
        let columnTop = restingY - (chapterLabel.isHidden ? 0 : chapterHeight + 2 * scale) - Skin.columnTop * scale
        fade.frame = CGRect(x: 0, y: columnTop, width: view.bounds.width, height: max(view.bounds.maxY - columnTop, 0))
        layoutTopLine(area: area, scale: scale, edge: edge)

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
            // A swapped-in item becomes ready while paused, when no time passes to redraw the controls.
            player.observe(\.currentItem?.status) { [weak self] _, _ in DispatchQueue.main.async { self?.refresh() } },
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
        if menu?.tag == subtitlesButton.hash || menu?.tag == qualityButton.hash { closeMenu() }
        loadSubtitles()
        loadQualities()
        applyHeldHeight()
        refresh()
    }

    /// The heights of the item's video variants, as its master states them.
    private func loadQualities() {
        guard let item = player.currentItem, let asset = item.asset as? AVURLAsset else { return }
        Task { @MainActor [weak self] in
            let variants: [AVAssetVariant]
            if #available(iOS 16.0, *) {
                variants = (try? await asset.load(.variants)) ?? []
            } else {
                variants = asset.variants
            }
            guard let self, self.player.currentItem === item else { return }
            let heights = variants.compactMap { $0.videoAttributes.map { Double($0.presentationSize.height) } }
            self.qualities = (item, VideoQuality.choices(heights: heights))
            self.refresh()
        }
    }

    /// The picture held to the chosen height or under it; the player cannot be pinned to one variant, only capped.
    private func applyHeldHeight() {
        guard let item = player.currentItem else { return }
        item.preferredMaximumResolution = heldHeight.map { CGSize(width: 100_000, height: CGFloat($0)) } ?? .zero
    }

    private func qualityItems() -> [FullscreenMenu.Item] {
        guard let qualities, qualities.item === player.currentItem, !qualities.heights.isEmpty else { return [] }
        let auto = FullscreenMenu.Item(title: texts.qualityAuto, selected: heldHeight == nil) { [weak self] in
            self?.chooseQuality(nil)
        }
        return [auto] + qualities.heights.map { height in
            .init(title: VideoQuality.label(height), selected: heldHeight == height) { [weak self] in self?.chooseQuality(height) }
        }
    }

    private func chooseQuality(_ height: Int?) {
        heldHeight = height
        applyHeldHeight()
        closeMenu()
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
        if let pending = switching, item !== switchingFrom, player.timeControlStatus == .playing || item?.status == .failed {
            pending.cancel()
            switching = nil
        }
        next.loading = item == nil || item?.status == .unknown || switching != nil
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
        // A triangle's weight sits left of its box's middle, so play is nudged right to look centred.
        playPause.iconShift = layout.showsPause ? 0 : 0.08
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
        let subtitleOn = subtitles.map { $0.item === item && $0.item.currentMediaSelection.selectedMediaOption(in: $0.group) != nil } ?? false
        subtitlesButton.layers = subtitleOn ? PlayerIcons.captionsCcOn : PlayerIcons.captionsCc
        let showsQuality = qualities?.item === item && qualities?.heights.isEmpty == false
        let qualityChanged = qualityButton.isHidden == showsQuality
        qualityButton.isHidden = !showsQuality
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
        var (elapsed, remaining) = timeTexts(shown)
        if showTotal, !shown.live {
            let total = max(shown.duration, shown.position)
            remaining = formatTime(total, guide: total)
        }
        if timeLabel.text != elapsed || remainingLabel.text != remaining {
            timeLabel.text = elapsed
            remainingLabel.text = remaining
            view.setNeedsLayout()
        }
        if rowChanged || qualityChanged { view.setNeedsLayout() }
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
            commands.seek(position)
            if held {
                rosterFraction = nil
                let markerX = progress.frame.minX + CGFloat(min(max(fraction, 0), 1)) * progress.frame.width - roster.frame.minX
                openPin(at: position, markerX: markerX)
            } else {
                hideRoster()
            }
            hidePicture()
            resumeFromScrub()
        } else {
            if scrubbing == nil { pauseForScrub() }
            scrubbing = position
            if rosterPinned { closePin() }
            if commands.thumbnails?.ready == true { updateRoster(fraction) }
            showPicture(position)
        }
        refresh()
    }

    private func pauseForScrub() {
        guard !resumeAfterScrub, state.playing else { return }
        resumeAfterScrub = true
        commands.pause()
    }

    private func resumeFromScrub() {
        guard resumeAfterScrub else { return }
        resumeAfterScrub = false
        commands.play()
    }

    // MARK: Roster

    /// The frame the web's hover preview shows: a sixth of the width, 16:9.
    private func rosterHeight(_ width: CGFloat) -> CGFloat {
        min(340, max(168, width / 6)) * 9 / 16
    }

    /// The frames are up: held from the timeline, or pinned open after it.
    private var rosterUp: Bool { rosterFraction != nil || rosterPinned }

    /// From the bottom edge over the buttons up to where the timeline rests; the frames are drawn at the hover
    /// preview's height.
    private func placeRoster() {
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let height = rosterHeight(area.width)
        let top = rowRest - height
        roster.tileHeight = height
        roster.frame = CGRect(x: area.minX, y: top, width: area.width, height: max(view.bounds.maxY - top, height))
    }

    /// The time over the lifted timeline, centred on `x` and kept inside the safe area.
    private func placeRosterLabel(_ time: Double, at x: CGFloat) {
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let scale = Skin.scale(forWidth: area.width)
        rosterLabel.text = formatTime(time, guide: state.duration)
        rosterLabel.sizeToFit()
        let half = rosterLabel.bounds.width / 2
        let centre = min(max(x, area.minX + half + 8), area.maxX - half - 8)
        rosterLabel.frame = CGRect(
            x: centre - half, y: progress.frame.minY - rosterLabel.bounds.height - 8 * scale,
            width: rosterLabel.bounds.width, height: rosterLabel.bounds.height
        )
        rosterLabel.isHidden = false
    }

    /// The frames came up or went down: the timeline lifts onto them or settles back, and nothing but the two stays
    /// while they are up, since the buttons would show through behind the strip and the fade would only dim it.
    private func rosterChanged() {
        let up = rosterUp
        guard up != rosterWasUp else { return }
        rosterWasUp = up
        progress.onRoster = up
        let parts: [UIView] = [
            muteButton, qualityButton, audioButton, rateButton, subtitlesButton, browseButton, airPlayButton, pipButton, exitButton,
            playPause, spinner, skipBack, skipForward, fade,
        ]
        UIView.animate(withDuration: 0.18) {
            parts.forEach { $0.alpha = up ? 0 : 1 }
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    private func updateRoster(_ fraction: Double) {
        guard state.duration > 0 else { return }
        let fraction = min(max(fraction, 0), 1)
        rosterFraction = fraction
        rosterChanged()
        placeRoster()
        // The marker sits under the finger.
        let markerX = progress.frame.minX + CGFloat(fraction) * progress.frame.width - roster.frame.minX
        let time = fraction * state.duration
        roster.show(time: time, markerX: min(max(markerX, 0), roster.frame.width), duration: state.duration)
        roster.isHidden = false
        placeRosterLabel(time, at: roster.frame.minX + markerX)
    }

    private func hideRoster() {
        rosterFraction = nil
        if !rosterPinned {
            roster.isHidden = true
            rosterLabel.isHidden = true
        }
        rosterChanged()
    }

    // MARK: Pinned roster

    private func openPin(at time: Double, markerX: CGFloat) {
        guard state.duration > 0, commands.thumbnails?.ready == true else { return }
        pinMarkerX = markerX
        rosterPinned = true
        rosterChanged()
        visibility.pinned = true
        roster.isUserInteractionEnabled = true
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
        roster.isUserInteractionEnabled = false
        hideRoster()
        hidePicture()
        visibility.pinned = false
    }

    /// The frame over the picture while the timeline or the strip is held: nothing shows at rest.
    private func showPicture(_ time: Double) {
        guard let frames = commands.thumbnails, frames.ready, state.duration > 0 else {
            hidePicture()
            return
        }
        scrubPicture.show(frames, time: time, duration: state.duration)
    }

    private func hidePicture() {
        scrubPicture.reset()
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
        placeRoster()
        let markerX = min(max(pinMarkerX, 0), roster.frame.width)
        let time = min(max(pinTime, 0), state.duration)
        roster.show(time: time, markerX: markerX, duration: state.duration)
        roster.isHidden = false
        placeRosterLabel(time, at: roster.frame.minX + markerX)
    }

    private func pinPanned(_ dx: CGFloat, _ gesture: UIGestureRecognizer.State) {
        guard rosterPinned, state.duration > 0,
              let perSecond = roster.pointsPerSecond(step: Roster.step(duration: state.duration)) else { return }
        visibility.touched()
        switch gesture {
        case .began:
            pauseForScrub()
            pinDrag = (pinTime, pinTime, false)
        case .changed:
            guard let drag = pinDrag else { return }
            // The strip follows the finger, so a drag to the right is back in time.
            let time = Roster.timeAfterDrag(
                startTime: drag.startTime, dx: Double(dx), pointsPerSecond: Double(perSecond), duration: state.duration
            )
            pinDrag = (drag.startTime, time, drag.moved || abs(dx) > 4)
            showPicture(time)
        case .ended:
            hidePicture()
            guard let drag = pinDrag else { return }
            pinDrag = nil
            if drag.moved {
                rest(at: drag.time)
                commands.seek(drag.time)
            }
            resumeFromScrub()
        default:
            pinDrag = nil
            hidePicture()
            resumeFromScrub()
        }
        updatePinned()
    }

    @objc private func tapped() {
        if rosterPinned {
            closePin()
            visibility.touched()
            return
        }
        if menu != nil {
            closeMenu()
            visibility.touched()
            return
        }
        visibility.tappedPicture()
    }

    @objc private func toggleTotal() {
        showTotal.toggle()
        visibility.touched()
        refresh()
    }

    @objc private func doubleTapped() {
        onLeave?()
    }

    /// Taps on a control, the bar or a menu are theirs, not the picture's.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view, current !== self.view {
            if current is UIControl || current === progress || current === roster || current === remainingLabel || current is FullscreenMenu
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
            self.placeSubtitles(controlsShown: visible)
        }
        placeNextUp(animated: true)
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
    }

    /// Leaving at the top right, on the line of the timeline's right end; what plays at the left, clear of it. The fade
    /// reaches the screen's top edge and sides, over the area the system keeps clear.
    private func layoutTopLine(area: CGRect, scale: CGFloat, edge: CGFloat) {
        let side = Skin.rowButton * scale
        let top = area.minY + 12 * scale
        exitButton.frame = CGRect(x: area.maxX - edge + 8 * scale - side + 1, y: top, width: side, height: side)
        headingTitle.font = .systemFont(ofSize: 17 * scale, weight: .bold)
        headingSubtitle.font = .systemFont(ofSize: 12 * scale, weight: .regular)
        let left = area.minX + edge
        let width = max(exitButton.frame.minX - 16 * scale - left, 0)
        let titleHeight = headingTitle.font.lineHeight.rounded(.up)
        headingTitle.frame = CGRect(x: left, y: top + (side - titleHeight) / 2 - (headingSubtitle.isHidden ? 0 : 7 * scale), width: width, height: titleHeight)
        let subtitleHeight = headingSubtitle.font.lineHeight.rounded(.up)
        headingSubtitle.frame = CGRect(x: left, y: headingTitle.frame.maxY, width: width, height: subtitleHeight)
        let foot = max(exitButton.frame.maxY, headingSubtitle.isHidden ? headingTitle.frame.maxY : headingSubtitle.frame.maxY) + 36 * scale
        topFade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: foot)
    }

    /// Names another video at the top left, when the one playing is swapped for it while full-screen stays open.
    func setHeading(title: String?, subtitle: String?) {
        let title = title?.trimmingCharacters(in: .whitespaces) ?? ""
        let subtitle = subtitle?.trimmingCharacters(in: .whitespaces) ?? ""
        headingTitle.text = title
        headingSubtitle.text = subtitle
        headingTitle.isHidden = title.isEmpty
        headingSubtitle.isHidden = title.isEmpty || subtitle.isEmpty
        headingTitle.accessibilityTraits = .header
        if isViewLoaded { view.setNeedsLayout() }
    }

    /// Over the chapter line and the timeline while they show, as the web player lifts its own; near the foot when
    /// they hide.
    private func placeSubtitles(controlsShown: Bool) {
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let scale = Skin.scale(forWidth: area.width)
        let width = min(area.width * 0.8, 900)
        subtitleLabel.font = .systemFont(ofSize: 18 * scale, weight: .semibold)
        let fit = subtitleLabel.sizeThatFits(CGSize(width: width, height: area.height / 2))
        let bottom = controlsShown ? min(chapterLabel.frame.minY, progress.frame.minY) - 10 * scale : area.maxY - 16 * scale
        subtitleLabel.frame = CGRect(x: area.midX - width / 2, y: bottom - fit.height, width: width, height: fit.height)
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
            self?.startSwitching()
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
        startSwitching()
        commands.nextUp(id)
    }

    private func startSwitching() {
        switching?.cancel()
        let limit = DispatchWorkItem { [weak self] in self?.endSwitching() }
        switching = limit
        switchingFrom = player.currentItem
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.switchingLimit, execute: limit)
        refresh()
    }

    private func endSwitching() {
        guard let switching else { return }
        switching.cancel()
        self.switching = nil
        refresh()
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
            bottom = (chapterLabel.isHidden ? progress.frame.minY : chapterLabel.frame.minY) - 8
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
        // Slowest first, as Android lists them.
        fullscreenRates.map { rate in
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
            self?.refresh()
        }
        return [off] + subtitles.options.map { option in
            .init(title: option.playlistName, selected: option == selected) { [weak self] in
                item.select(option, in: subtitles.group)
                self?.closeMenu()
                self?.refresh()
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

    /// Centred over the button that opened it and just above it, kept inside the screen.
    private func place(_ menu: FullscreenMenu) {
        guard let button = controls.subviews.first(where: { $0 !== menu && $0.hash == menu.tag }) else { return }
        var frame = menu.bounds
        frame.origin.x = min(max(button.frame.midX - frame.width / 2, 8), max(view.bounds.width - frame.width - 8, 8))
        frame.origin.y = max(button.frame.minY - frame.height - 4, 8)
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

/// The timeline: thick and round with no knob, the fill being the playhead, cut at the chapter starts. The track
/// grows a little while held, and stays so while the frames are under it. Dragging or tapping it seeks.
final class ProgressBar: UIView {
    /// The fraction the viewer points at, and whether they let go.
    var onScrub: ((Double, Bool) -> Void)?
    /// Where each chapter after the first starts, as a fraction of the bar: ``ChapterCuts/starts(_:duration:)``.
    var cuts: [Double] = [] {
        didSet { if cuts != oldValue { setNeedsLayout() } }
    }
    /// The skin's scale, which the track and the gaps between chapters grow with.
    var scale: CGFloat = 1 {
        didSet { if scale != oldValue { setNeedsLayout() } }
    }
    /// The frames are under the bar: it is as thick as when held.
    var onRoster = false {
        didSet { if onRoster != oldValue { setNeedsLayout() } }
    }

    /// The three bars, masked together so a cut goes through all of them.
    private let bars = UIView()
    private let cutMask = CAShapeLayer()
    private let track = UIView()
    private let loaded = UIView()
    private let played = UIView()
    private var playedFraction: Double = 0
    private var loadedFraction: Double = 0
    private var held = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        track.backgroundColor = Skin.trackColor
        loaded.backgroundColor = Skin.loadedColor
        played.backgroundColor = .white
        bars.isUserInteractionEnabled = false
        addSubview(bars)
        for part in [track, loaded, played] {
            part.isUserInteractionEnabled = false
            bars.addSubview(part)
        }
        cutMask.fillRule = .evenOdd
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
        let thickness = (held || onRoster ? Skin.trackHeld : Skin.track) * scale
        let y = (bounds.height - thickness) / 2
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
        track.frame = CGRect(x: 0, y: y, width: bounds.width, height: thickness)
        loaded.frame = CGRect(x: 0, y: y, width: bounds.width * loadedFraction, height: thickness)
        played.frame = CGRect(x: 0, y: y, width: bounds.width * playedFraction, height: thickness)
        for part in [track, loaded, played] { part.layer.cornerRadius = thickness / 2 }
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let fraction = Double(pan.location(in: self).x / max(bounds.width, 1))
        switch pan.state {
        case .began, .changed:
            held = true
            onScrub?(fraction, false)
        case .ended, .cancelled:
            held = false
            onScrub?(fraction, true)
        default: break
        }
        setNeedsLayout()
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
