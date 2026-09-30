#if canImport(UIKit)
import AVKit
import LuminaryPlayerCore
import UIKit

/// The iOS ``FullscreenPresenter``: an `AVPlayerViewController` presented full-screen over the
/// host's view controller (the Capacitor bridge's, in the app). The view only borrows the engine's
/// player; dismissing hands it back.
///
/// The viewer closing it (its close button, or swiping it down) is reported through `onLeave`,
/// and the engine then dismisses it the way `exitFullscreen` does, pause included.
public final class PlayerViewControllerPresenter: FullscreenPresenter {
    private let host: () -> UIViewController?
    private var controller: LeavingPlayerViewController?
    private var onLeave: (() -> Void)?
    /// A dismissal still animating; UIKit refuses to present until it has finished.
    private var dismissing = false
    private var presentWhenDismissed: (() -> Void)?

    /// `host` is asked for the view controller to present over each time full-screen begins.
    public init(host: @escaping () -> UIViewController?) {
        self.host = host
    }

    public func present(_ player: AVPlayer, onLeave: @escaping () -> Void) -> Bool {
        guard controller == nil, host() != nil else { return false }

        let controller = LeavingPlayerViewController()
        controller.player = player
        controller.modalPresentationStyle = .fullScreen
        // Picture in picture arrives with the phase 2 presenter.
        controller.allowsPictureInPicturePlayback = false
        // Each view reports only its own disappearance, and only while it is the one presented:
        // a view still animating out must not end the presentation that replaced it.
        controller.onDisappear = { [weak self, weak controller] in
            guard let self, let controller, self.controller === controller else { return }
            self.onLeave?()
        }
        self.controller = controller
        self.onLeave = onLeave

        let show = { [weak self] in
            guard let self, self.controller === controller, var presenter = self.host() else { return }
            // Present over whatever the host is already presenting.
            while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
                presenter = presented
            }
            presenter.present(controller, animated: true)
        }
        if dismissing { presentWhenDismissed = show } else { show() }
        return true
    }

    public func dismiss() -> Bool {
        guard let controller else { return false }
        // Cleared first, so the disappearance this dismissal causes is not read as the viewer
        // leaving.
        self.controller = nil
        onLeave = nil
        presentWhenDismissed = nil
        // Detached before it goes: AVPlayerViewController pauses its player as it disappears,
        // which would otherwise land on a player that is already playing again, or shown full-
        // screen once more. Measured on the device, not assumed.
        controller.player = nil
        guard controller.presentingViewController != nil else { return true }
        dismissing = true
        controller.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            self.dismissing = false
            let show = self.presentWhenDismissed
            self.presentWhenDismissed = nil
            show?()
        }
        return true
    }
}

/// Reports its own dismissal, which is how a viewer closing it becomes visible.
private final class LeavingPlayerViewController: AVPlayerViewController {
    var onDisappear: (() -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil { onDisappear?() }
    }
}
#endif
