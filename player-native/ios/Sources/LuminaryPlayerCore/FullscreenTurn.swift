import Foundation

/// Which way full-screen may face around a turn it asks for itself, and when turning the phone
/// upright leaves it.
///
/// A host whose pages stay upright opens full-screen with the interface still upright, so
/// full-screen turns it sideways itself. While that turn is on its way the interface is held to
/// landscape. After it, the hold stays until the phone itself is on its side: letting the interface
/// follow a phone still held upright would turn it straight back, and leave. Once the phone has
/// been sideways, turning it upright again is the viewer leaving.
public struct FullscreenTurn: Equatable {
    /// Full-screen asked the system to turn sideways, and the turn has not arrived.
    public private(set) var turning = false
    /// The interface is held to landscape, whatever the phone does.
    public private(set) var holdingLandscape = false

    public init() {}

    /// Full-screen asks the system to turn sideways.
    public mutating func began() {
        turning = true
        holdingLandscape = true
    }

    /// The turn arrived, failed, or ran out of time. Returns whether the hold was let go, which the
    /// interface has to be told about.
    @discardableResult
    public mutating func ended(deviceSideways: Bool) -> Bool {
        guard turning else { return false }
        turning = false
        return release(if: deviceSideways)
    }

    /// The phone was turned. Returns whether the hold was let go.
    @discardableResult
    public mutating func deviceTurned(sideways: Bool) -> Bool {
        guard !turning else { return false }
        return release(if: sideways)
    }

    /// Whether the interface turning to `size` is the viewer turning the phone upright to leave:
    /// not a turn full-screen asked for, and only for a picture wider than tall.
    public func leaves(toWidth width: Double, height: Double, videoIsLandscape: Bool) -> Bool {
        !turning && videoIsLandscape && height > width
    }

    private mutating func release(if sideways: Bool) -> Bool {
        guard holdingLandscape, sideways else { return false }
        holdingLandscape = false
        return true
    }
}
