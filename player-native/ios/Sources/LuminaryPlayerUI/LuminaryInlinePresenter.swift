#if canImport(UIKit)
import AVFoundation
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
    /// What the web view looked like before it was made see-through.
    private var restore: (opaque: Bool, background: UIColor?, scrollBackground: UIColor?)?

    /// `webView` is asked for the Capacitor bridge's web view each time.
    public init(webView: @escaping () -> WKWebView?) {
        self.webView = webView
    }

    public func setFrame(_ frame: InlineFrame?, player: AVPlayer) {
        self.frame = frame
        self.player = player
        guard let frame, let webView = webView(), let container = webView.superview else {
            tearDown()
            return
        }
        let view = videoView ?? makeVideoView(in: container, below: webView)
        // The page's coordinates are the web view's: its own origin, then the frame.
        view.frame = CGRect(
            x: webView.frame.minX + frame.x, y: webView.frame.minY + frame.y,
            width: frame.width, height: frame.height
        )
        makeTransparent(webView)
        view.playerLayer.player = suspended ? nil : player
    }

    public func setSuspended(_ suspended: Bool) {
        self.suspended = suspended
        videoView?.playerLayer.player = suspended ? nil : player
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
