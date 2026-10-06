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

    /// Full-screen or picture in picture holds the picture: the inline view lets go of the player
    /// (true) and takes it back (false). The frame it was given stays.
    func setSuspended(_ suspended: Bool)
}
