import AVFoundation

/// Where a presented player is shown: the bridge's `presentationchange` states.
public enum Presentation: String {
    case inline, fullscreen, pip
}

/// Shows an engine's player full-screen. The view only borrows the player; dismissing hands it
/// back. The iOS implementation (`AVPlayerViewController` over the bridge's view controller) sits
/// in the plugin target, beside UIKit.
public protocol FullscreenPresenter: AnyObject {
    /// False when already presented, or there is nowhere to present. `onLeave` is the viewer
    /// asking to leave; the engine decides what that means and dismisses. `onPresentation` is the
    /// viewer moving the player between full-screen and picture in picture.
    func present(
        _ player: AVPlayer,
        onLeave: @escaping () -> Void,
        onPresentation: @escaping (Presentation) -> Void
    ) -> Bool

    /// False when nothing was presented.
    func dismiss() -> Bool
}
