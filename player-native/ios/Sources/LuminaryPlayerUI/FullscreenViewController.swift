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
    private let playPause = GlyphButton(size: Skin.play, iconSize: Skin.playIcon)
    private let spinner = SpinnerView()
    private let skipBack = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon)
    private let skipForward = GlyphButton(size: Skin.skip, iconSize: Skin.skipIcon)
    private let audioButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let pipButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let subtitlesButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let rateButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let muteButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let exitButton = GlyphButton(size: Skin.control, iconSize: Skin.icon)
    private let progress = ProgressBar()
    private let timeLabel = UILabel()

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
        if player.rate > 0 { rate = roundedRate(Double(player.rate)) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Presentation

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    /// Whatever the app allows: full-screen opens the way the phone is held and follows it, as on
    /// Android. Unlike `player-web`, which locks to landscape on entering full-screen.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        UIApplication.shared.supportedInterfaceOrientations(for: view.window)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.playerLayer.videoGravity = .resizeAspect
        view.addSubview(videoView)

        controls.backgroundColor = Skin.scrim
        view.addSubview(controls)
        for button in [playPause, skipBack, skipForward, audioButton, pipButton, subtitlesButton, rateButton, muteButton, exitButton] {
            controls.addSubview(button)
        }
        controls.addSubview(spinner)
        controls.addSubview(progress)
        timeLabel.font = Skin.text
        timeLabel.textColor = .white
        controls.addSubview(timeLabel)

        exitButton.glyph = VideoJsIcons.fullscreenExit
        exitButton.accessibilityLabel = texts.exitFullscreen
        pipButton.glyph = VideoJsIcons.pictureInPictureEnter
        pipButton.accessibilityLabel = texts.pictureInPicture
        audioButton.glyph = VideoJsIcons.audio
        audioButton.accessibilityLabel = texts.audioMenu
        subtitlesButton.glyph = VideoJsIcons.subtitles
        subtitlesButton.accessibilityLabel = texts.subtitlesMenu
        rateButton.accessibilityLabel = texts.playbackRate
        spinner.accessibilityLabel = texts.loading
        progress.accessibilityLabel = texts.seek

        on(playPause) { $0.state.playing ? $0.commands.pause() : $0.commands.play() }
        on(skipBack) { $0.skip(by: -Double($0.layout?.skipBack ?? 0)) }
        on(skipForward) { $0.skip(by: Double($0.layout?.skipForward ?? 0)) }
        on(exitButton) { $0.onLeave?() }
        on(pipButton) { $0.onPictureInPicture?() }
        on(muteButton) { $0.player.isMuted.toggle(); $0.refresh() }
        on(rateButton) { $0.openMenu(from: $0.rateButton, items: $0.rateItems()) }
        on(audioButton) { $0.openMenu(from: $0.audioButton, items: $0.audioItems()) }
        on(subtitlesButton) { $0.openMenu(from: $0.subtitlesButton, items: $0.subtitleItems()) }
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
        stopObserving()
        visibility.stop()
        closeMenu()
        videoView.playerLayer.player = nil
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        videoView.frame = view.bounds
        controls.frame = view.bounds
        let area = view.bounds.inset(by: view.safeAreaInsets)
        let centre = CGPoint(x: area.midX, y: area.midY)

        playPause.frame = square(Skin.play, at: centre)
        spinner.frame = playPause.frame
        skipBack.frame = square(Skin.skip, at: CGPoint(x: centre.x - Skin.skipOffset, y: centre.y - Skin.skipLift))
        skipForward.frame = square(Skin.skip, at: CGPoint(x: centre.x + Skin.skipOffset, y: centre.y - Skin.skipLift))

        // The top row, in `player-web`'s order, closing up around what is hidden.
        var x = area.minX
        for button in [audioButton, pipButton, subtitlesButton, rateButton, muteButton] where !button.isHidden {
            button.frame = CGRect(x: x, y: area.minY, width: Skin.control, height: Skin.control)
            x += Skin.control
        }

        exitButton.frame = CGRect(x: area.maxX - Skin.control, y: area.maxY - Skin.control, width: Skin.control, height: Skin.control)
        // The bottom row: the time (native only), then the bar up to the exit button's corner.
        let rowMid = area.maxY - Skin.control / 2
        timeLabel.sizeToFit()
        timeLabel.frame = CGRect(
            x: area.minX + 8, y: rowMid - timeLabel.bounds.height / 2,
            width: timeLabel.bounds.width, height: timeLabel.bounds.height
        )
        let barStart = timeLabel.text?.isEmpty == false ? timeLabel.frame.maxX + 10 : area.minX + Skin.progressInset
        progress.frame = CGRect(x: barStart, y: area.maxY - Skin.control, width: area.maxX - 50 - barStart, height: Skin.control)

        menu.map(place)
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
        observations = [
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
        next.duration = duration.isNumeric ? duration.seconds : 0
        let position = player.currentTime().seconds
        next.position = scrubbing ?? (position.isFinite ? position : 0)
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

        playPause.glyph = layout.showsPause ? VideoJsIcons.pause : VideoJsIcons.play
        playPause.accessibilityLabel = layout.showsPause ? texts.pause : texts.play
        playPause.isHidden = layout.showsSpinner
        spinner.isHidden = !layout.showsSpinner
        skipBack.isHidden = layout.skipBack == nil
        skipBack.glyph = layout.skipBack.map(Self.replayGlyph)
        skipBack.accessibilityLabel = layout.skipBack.map(texts.skipBack)
        skipForward.isHidden = layout.skipForward == nil
        skipForward.glyph = layout.skipForward.map(Self.forwardGlyph)
        skipForward.accessibilityLabel = layout.skipForward.map(texts.skipForward)
        audioButton.isHidden = !layout.showsAudioMenu
        subtitlesButton.isHidden = !layout.showsSubtitlesMenu
        pipButton.isHidden = !pictureInPictureAvailable
        rateButton.isHidden = !layout.showsRate
        rateButton.text = rateLabel(next.rate)
        muteButton.glyph = next.muted ? VideoJsIcons.volumeMute : VideoJsIcons.volumeHigh
        muteButton.accessibilityLabel = next.muted ? texts.unmute : texts.mute

        progress.isHidden = !layout.showsProgress
        if layout.showsProgress, next.duration > 0 {
            progress.update(played: next.position / next.duration, loaded: next.loadedEnd / next.duration)
            progress.accessibilityValue = timeText(next)
        }
        let time = timeText(next)
        if timeLabel.text != time {
            timeLabel.text = time
            view.setNeedsLayout()
        }
        if rowChanged { view.setNeedsLayout() }
        visibility.playbackChanged(playing: next.playing)
    }

    private func loadedEnd(_ item: AVPlayerItem?, at position: Double) -> Double {
        guard let ranges = item?.loadedTimeRanges.map(\.timeRangeValue) else { return 0 }
        let containing = ranges.first { $0.start.seconds <= position + 0.5 && position <= $0.end.seconds + 0.5 }
        return containing?.end.seconds ?? 0
    }

    private static func replayGlyph(_ seconds: Int) -> VideoJsGlyph {
        seconds == 5 ? VideoJsIcons.replay5 : seconds == 30 ? VideoJsIcons.replay30 : VideoJsIcons.replay10
    }

    private static func forwardGlyph(_ seconds: Int) -> VideoJsGlyph {
        seconds == 5 ? VideoJsIcons.forward5 : seconds == 30 ? VideoJsIcons.forward30 : VideoJsIcons.forward10
    }

    // MARK: Actions

    /// Every control's action also keeps the controls up for another 3 s.
    private func on(_ button: UIControl, _ action: @escaping (FullscreenViewController) -> Void) {
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.visibility.touched()
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
            commands.seek(position)
        } else {
            scrubbing = position
        }
        refresh()
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
            if current is UIControl || current === progress || current is FullscreenMenu { return false }
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
        UIAccessibility.post(notification: .layoutChanged, argument: nil)
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
            .init(title: option.displayName, selected: option == selected) { [weak self] in
                item.select(option, in: subtitles.group)
                self?.closeMenu()
            }
        }
    }

    private func openMenu(from button: UIView, items: [FullscreenMenu.Item]) {
        let reopen = menu?.tag != button.hash
        closeMenu()
        guard reopen, !items.isEmpty else { return }
        // A pick is a touch like any other: the controls stay another 3 s, then hide.
        let menu = FullscreenMenu(items: items.map { item in
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

/// The progress bar: a 4 pt rounded track, what is loaded, what is played and a knob. Dragging
/// or tapping it seeks.
final class ProgressBar: UIView {
    /// The fraction the viewer points at, and whether they let go.
    var onScrub: ((Double, Bool) -> Void)?

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
        for part in [track, loaded, played, knob] {
            part.isUserInteractionEnabled = false
            addSubview(part)
        }
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
        let y = (bounds.height - Skin.progressHeight) / 2
        let radius = Skin.progressHeight / 2
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
