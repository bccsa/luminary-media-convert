import AVFoundation

/// Shows an engine's player full-screen. The view only borrows the player; dismissing hands it
/// back. The iOS implementation (`AVPlayerViewController` over the bridge's view controller) sits
/// in the plugin target, beside UIKit.
public protocol FullscreenPresenter: AnyObject {
    /// False when already presented, or there is nowhere to present. `onLeave` is the viewer
    /// asking to leave; the engine decides what that means and dismisses.
    func present(_ player: AVPlayer, onLeave: @escaping () -> Void) -> Bool

    /// False when nothing was presented.
    func dismiss() -> Bool
}
