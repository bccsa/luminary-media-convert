import Foundation

/// What was last told to the page, so only a change is told again: a repeat can reach the page after the page's
/// own pick and undo it.
public struct ChangeReport<Value: Equatable>: Equatable {
    public private(set) var told: Value

    /// `initial` is what the page assumes before anything is told.
    public init(_ initial: Value) { told = initial }

    /// Whether `value` is news; if it is, it becomes what was told.
    public mutating func tells(_ value: Value) -> Bool {
        guard value != told else { return false }
        told = value
        return true
    }
}
