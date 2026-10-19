import Foundation

/// How the phone is held, as far as turning the picture goes. Flat, upside down and unknown are
/// none of these, and say nothing about a turn.
public enum PhonePose: Equatable {
    case upright
    case sideways
}

/// The last pose the phone was held in: readings that say nothing (flat, upside down, unknown) keep
/// it, so tilting a phone held sideways back towards the sky does not undo the turn.
public struct PoseReading: Equatable {
    public private(set) var pose: PhonePose?

    public init(_ pose: PhonePose? = nil) { self.pose = pose }

    /// Returns whether the pose changed.
    @discardableResult
    public mutating func read(_ reading: PhonePose?) -> Bool {
        guard let reading, reading != pose else { return false }
        pose = reading
        return true
    }
}

/// When turning the phone upright leaves full-screen. Full-screen opened with the phone still held
/// upright turns the picture sideways by itself, so the phone being upright says nothing until it
/// has been on its side; after that, turning it upright is the viewer leaving.
public struct UprightExit: Equatable {
    public private(set) var beenSideways = false

    public init() {}

    /// Returns whether this pose is the viewer turning the phone upright to leave.
    public mutating func saw(_ pose: PhonePose?) -> Bool {
        switch pose {
        case .sideways:
            beenSideways = true
            return false
        case .upright:
            return beenSideways
        case nil:
            return false
        }
    }
}
