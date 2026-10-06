#if canImport(UIKit)
import AVKit
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The iOS ``FullscreenPresenter``: ``FullscreenViewController``, drawn to `player-web`'s
/// full-screen skin, presented full-screen over the host's view controller (the Capacitor
/// bridge's, in the app). The view only borrows the engine's player; dismissing hands it back.
///
/// The viewer leaving (the exit button, or a double tap) is reported through `onLeave`, and the
/// engine then dismisses it the way `exitFullscreen` does, pause included.
///
/// Picture in picture runs from the view's own player layer. Starting it takes the view down,
/// which is not the viewer leaving; returning from it puts the same view back, and closing it is
/// leaving.
public final class LuminaryFullscreenPresenter: NSObject, FullscreenPresenter {
    private let host: () -> UIViewController?
    private let clock: Clock
    private var controller: FullscreenViewController?
    private var pictureInPicture: AVPictureInPictureController?
    private var onLeave: (() -> Void)?
    private var onPresentation: ((Presentation) -> Void)?
    /// A dismissal still animating; UIKit refuses to present until it has finished.
    private var dismissing = false
    private var presentWhenDismissed: (() -> Void)?

    /// `host` is asked for the view controller to present over each time full-screen begins.
    public init(host: @escaping () -> UIViewController?, clock: Clock = MainQueueClock()) {
        self.host = host
        self.clock = clock
    }

    public func present(
        _ player: AVPlayer,
        commands: FullscreenCommands,
        texts: FullscreenTexts,
        onLeave: @escaping () -> Void,
        onPresentation: @escaping (Presentation) -> Void
    ) -> Bool {
        guard controller == nil, host() != nil else { return false }
        // Picture in picture is offered only to a playback session.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)

        let controller = FullscreenViewController(player: player, commands: commands, texts: texts, clock: clock)
        controller.modalPresentationStyle = .fullScreen
        controller.loadViewIfNeeded()
        controller.videoView.playerLayer.player = player
        controller.onLeave = { [weak self, weak controller] in
            guard let self, let controller, self.controller === controller else { return }
            self.onLeave?()
        }
        if AVPictureInPictureController.isPictureInPictureSupported(),
           let pictureInPicture = AVPictureInPictureController(playerLayer: controller.videoView.playerLayer) {
            pictureInPicture.delegate = self
            // The app going to the background from full-screen carries on in picture in picture.
            pictureInPicture.canStartPictureInPictureAutomaticallyFromInline = true
            self.pictureInPicture = pictureInPicture
            controller.onPictureInPicture = { [weak pictureInPicture] in pictureInPicture?.startPictureInPicture() }
            controller.pictureInPictureAvailable = true
        }
        self.controller = controller
        self.onLeave = onLeave
        self.onPresentation = onPresentation

        let show = { [weak self] in
            guard let self, self.controller === controller else { return }
            self.show(controller, completion: nil)
        }
        if dismissing { presentWhenDismissed = show } else { show() }
        return true
    }

    public func startPictureInPicture() -> Bool {
        guard controller != nil, let pictureInPicture, pictureInPicture.isPictureInPicturePossible else { return false }
        pictureInPicture.startPictureInPicture()
        return true
    }

    public func dismiss() -> Bool {
        guard let controller else { return false }
        // Cleared first, so nothing this dismissal causes is read as the viewer leaving.
        self.controller = nil
        onLeave = nil
        onPresentation = nil
        presentWhenDismissed = nil
        // Detaching the player from the layer also ends picture in picture.
        pictureInPicture?.delegate = nil
        pictureInPicture = nil
        controller.detach()
        // Already coming down (stepping aside for picture in picture): that dismissal is the one
        // in flight, and a second would be refused or leave `dismissing` set for good.
        guard controller.presentingViewController != nil, !controller.isBeingDismissed else { return true }
        takeDown(controller)
        return true
    }

    /// Every dismissal goes through here, so `dismissing` always ends with the animation and a
    /// presentation parked behind it runs.
    private func takeDown(_ controller: UIViewController) {
        dismissing = true
        controller.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            self.dismissing = false
            let show = self.presentWhenDismissed
            self.presentWhenDismissed = nil
            show?()
        }
    }

    /// Presents over whatever the host is already presenting.
    private func show(_ controller: UIViewController, completion: (() -> Void)?) {
        guard var presenter = host() else {
            completion?()
            return
        }
        while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
            presenter = presented
        }
        presenter.present(controller, animated: true, completion: completion)
    }
}

extension LuminaryFullscreenPresenter: AVPictureInPictureControllerDelegate {
    /// The picture is in its own window now: the full-screen view steps aside, kept for the
    /// return, and JavaScript is told. Not earlier: picture in picture can still refuse to start,
    /// and then the view is still up and nothing was said.
    public func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPicture: AVPictureInPictureController) {
        guard pictureInPicture === self.pictureInPicture else { return }
        onPresentation?(.pip)
        guard let controller, controller.presentingViewController != nil, !controller.isBeingDismissed else { return }
        takeDown(controller)
    }

    /// The system declined: full-screen stays as it is, and so does what JavaScript was told.
    public func pictureInPictureController(
        _ pictureInPicture: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {}

    /// The viewer returning to full-screen from picture in picture: the view comes back.
    public func pictureInPictureController(
        _ pictureInPicture: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        guard pictureInPicture === self.pictureInPicture, let controller, controller.presentingViewController == nil else {
            completionHandler(true)
            return
        }
        show(controller) { completionHandler(true) }
    }

    /// Back in full-screen when the view was restored; closing picture in picture is leaving.
    public func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPicture: AVPictureInPictureController) {
        guard pictureInPicture === self.pictureInPicture else { return }
        if controller?.presentingViewController != nil {
            onPresentation?(.fullscreen)
        } else {
            onLeave?()
        }
    }
}
#endif
