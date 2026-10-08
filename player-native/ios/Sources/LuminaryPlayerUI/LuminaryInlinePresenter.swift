#if canImport(UIKit)
import AVFoundation
import AVKit
import UIKit
import WebKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The iOS ``InlinePresenter``: the player's picture in a view *behind* the web view, in the frame
/// JavaScript names, which the page leaves see-through (it clears its own backgrounds there). The
/// page keeps drawing whatever it likes over the picture (the full-screen button, panels), which a
/// view laid over the web view could not allow.
///
/// While the view shows, the web view is made transparent; when it hides, the web view is as it
/// was. The picture is the same `AVPlayer` the full-screen view borrows, so it lets go of it
/// (``setSuspended``) while full-screen or picture in picture holds the picture.
public final class LuminaryInlinePresenter: NSObject, InlinePresenter {
    private let webView: () -> WKWebView?
    private var videoView: PlayerLayerView?
    private var frame: InlineFrame?
    private var suspended = false
    private weak var player: AVPlayer?
    public var onRotatedToLandscape: (() -> Void)?
    public var onRotatedToPortrait: (() -> Void)?
    public var onPictureInPicture: ((Bool) -> Void)?
    private var pictureInPicture: AVPictureInPictureController?
    private var routePicker: AVRoutePickerView?
    private var rotationObserver: NSObjectProtocol?
    private var frameObservation: NSKeyValueObservation?
    private var wasOnScreen = false
    private var settleCheck: DispatchWorkItem?
    private var heldPicture: UIView?
    private var readyObservation: NSKeyValueObservation?
    /// What the web view looked like before it was made see-through.
    private var restore: (opaque: Bool, background: UIColor?, scrollBackground: UIColor?)?

    /// `webView` is asked for the Capacitor bridge's web view each time.
    public init(webView: @escaping () -> WKWebView?) {
        self.webView = webView
        super.init()
        // Capacitor's view controller posts this as the interface starts to turn; it has turned
        // once the animation is over, which is what the interface orientation reports.
        rotationObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("CapacitorViewWillTransition"), object: nil, queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.rotated() }
        }
    }

    deinit {
        if let rotationObserver { NotificationCenter.default.removeObserver(rotationObserver) }
    }

    /// Only a video the page is showing, and that nothing else holds, turns into full-screen.
    private func rotated() {
        guard frame != nil, !suspended,
              let landscape = webView()?.window?.windowScene?.interfaceOrientation.isLandscape else { return }
        if landscape { onRotatedToLandscape?() } else { onRotatedToPortrait?() }
    }

    public func setFrame(_ frame: InlineFrame?, player: AVPlayer) {
        let appeared = frame != nil && self.frame == nil
        self.frame = frame
        self.player = player
        guard let frame, let webView = webView(), let container = webView.superview else {
            tearDown()
            return
        }
        let view = videoView ?? makeVideoView(in: container, below: webView)
        // The web view moves too (the status bar's resize after a turn): the picture follows it.
        if frameObservation == nil {
            frameObservation = webView.observe(\.frame) { [weak self] _, _ in
                DispatchQueue.main.async { self?.layout() }
            }
        }
        layout()
        makeTransparent(webView)
        let onScreen = view.frame.intersects(webView.frame)
        if onScreen && !wasOnScreen && videoView != nil && !suspended {
            // A paused picture that was moved out of sight (the player slid away) comes back with
            // no frame until something redraws it: attach the layer afresh.
            view.playerLayer.player = nil
        }
        wasOnScreen = onScreen
        view.playerLayer.player = suspended ? nil : player
        scheduleSettleCheck()
        // A turn that came before the picture had a place in the page was not heard (nothing to
        // show yet); a phone already on its side when the picture appears counts as turned.
        if appeared {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.rotated() }
        }
    }

    /// Once the page stops moving the picture, a layer with nothing to show is attached afresh.
    private func scheduleSettleCheck() {
        settleCheck?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.suspended, let layer = self.videoView?.playerLayer,
                  self.wasOnScreen, !layer.isReadyForDisplay else { return }
            layer.player = nil
            layer.player = self.player
        }
        settleCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// The page's coordinates are the web view's: its own origin, then the frame.
    private func layout() {
        guard let frame, let webView = webView(), let view = videoView else { return }
        view.frame = CGRect(
            x: webView.frame.minX + frame.x, y: webView.frame.minY + frame.y,
            width: frame.width, height: frame.height
        )
        heldPicture?.frame = view.frame
    }

    /// From the inline layer: the picture continues in its own window, and the page goes on.
    public func startPictureInPicture() -> Bool {
        guard let layer = videoView?.playerLayer, !suspended,
              AVPictureInPictureController.isPictureInPictureSupported() else { return false }
        if pictureInPicture == nil || pictureInPicture?.playerLayer !== layer {
            pictureInPicture = AVPictureInPictureController(playerLayer: layer)
            pictureInPicture?.delegate = self
        }
        guard let pictureInPicture, pictureInPicture.isPictureInPicturePossible,
              !pictureInPicture.isPictureInPictureActive else { return false }
        pictureInPicture.startPictureInPicture()
        return true
    }

    /// Apple's own device list. Its button is a view that has to be in the window to answer, so a
    /// 1pt picker sits in the web view's container and is pressed on the viewer's behalf.
    public func showRoutePicker() -> Bool {
        guard let container = webView()?.superview else { return false }
        let picker = routePicker ?? AVRoutePickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        picker.prioritizesVideoDevices = true
        picker.alpha = 0.011
        if picker.superview !== container { container.addSubview(picker) }
        routePicker = picker
        for case let button as UIButton in picker.subviews { button.sendActions(for: .touchUpInside) }
        return true
    }

    public func holdPicture() {
        guard let videoView, let container = videoView.superview, !suspended, heldPicture == nil,
              let still = videoView.snapshotView(afterScreenUpdates: false) else { return }
        still.frame = videoView.frame
        container.insertSubview(still, aboveSubview: videoView)
        heldPicture = still
        // Down again when the new picture shows its first frame, and in any case after a while.
        readyObservation = videoView.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
            if layer.isReadyForDisplay { DispatchQueue.main.async { self?.releasePicture() } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.releasePicture() }
    }

    private func releasePicture() {
        readyObservation = nil
        heldPicture?.removeFromSuperview()
        heldPicture = nil
    }

    public func setSuspended(_ suspended: Bool) {
        self.suspended = suspended
        guard let layer = videoView?.playerLayer else { return }
        guard !suspended else {
            layer.player = nil
            return
        }
        // Taking the picture back after full-screen: the layer is attached afresh, and again once
        // the dismissal has settled and the page has turned back, as a layer that was attached
        // while the view was still moving can come back showing nothing.
        layout()
        layer.player = nil
        for delay in [0.0, 0.6] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, !self.suspended, let layer = self.videoView?.playerLayer else { return }
                self.layout()
                layer.player = self.player
            }
        }
    }

    private func makeVideoView(in container: UIView, below webView: UIView) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.backgroundColor = .black
        view.playerLayer.videoGravity = .resizeAspect
        view.isUserInteractionEnabled = false
        container.insertSubview(view, belowSubview: webView)
        videoView = view
        return view
    }

    private func makeTransparent(_ webView: WKWebView) {
        if restore == nil {
            restore = (webView.isOpaque, webView.backgroundColor, webView.scrollView.backgroundColor)
        }
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
    }

    private func tearDown() {
        pictureInPicture = nil
        routePicker?.removeFromSuperview()
        routePicker = nil
        frameObservation = nil
        settleCheck?.cancel()
        releasePicture()
        wasOnScreen = false
        videoView?.playerLayer.player = nil
        videoView?.removeFromSuperview()
        videoView = nil
        if let restore, let webView = webView() {
            webView.isOpaque = restore.opaque
            webView.backgroundColor = restore.background
            webView.scrollView.backgroundColor = restore.scrollBackground
        }
        restore = nil
    }
}
#endif

#if canImport(UIKit)
extension LuminaryInlinePresenter: AVPictureInPictureControllerDelegate {
    /// Said once the picture is in its own window, not when it was asked for: it can still refuse.
    public func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
        onPictureInPicture?(true)
    }

    public func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        onPictureInPicture?(false)
    }
}
#endif
