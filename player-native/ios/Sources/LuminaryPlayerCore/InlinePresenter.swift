import AVFoundation

/// A rectangle in the web view's coordinates, in CSS pixels: what `getBoundingClientRect()`
/// reports for the element the video belongs in.
public struct InlineFrame: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Shows an engine's player inside the page, behind the (transparent) web view, in the frame
/// JavaScript names. The implementation sits in `LuminaryPlayerUI`, beside UIKit. Main thread only.
public protocol InlinePresenter: AnyObject {
    /// Shows `player` in `frame`, or hides it when `frame` is nil.
    func setFrame(_ frame: InlineFrame?, player: AVPlayer)

    /// The phone was turned to landscape while the video shows in the page: the engine decides
    /// whether that opens full-screen (it plays, and its picture is wider than tall).
    var onRotatedToLandscape: (() -> Void)? { get set }

    /// The phone was turned back upright while the video shows in the page.
    var onRotatedToPortrait: (() -> Void)? { get set }

    /// Starts picture in picture from the inline picture. False when there is none to start from.
    func startPictureInPicture() -> Bool

    /// Opens the system's AirPlay device list over the page. False when there is nowhere to show it.
    func showRoutePicker() -> Bool

    /// Picture in picture started from the inline picture has started (true) or ended (false).
    var onPictureInPicture: ((Bool) -> Void)? { get set }

    /// Full-screen or picture in picture holds the picture: the inline view lets go of the player
    /// (true) and takes it back (false). The frame it was given stays.
    func setSuspended(_ suspended: Bool)
}
