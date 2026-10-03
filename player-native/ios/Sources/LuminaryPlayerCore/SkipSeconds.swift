/// The intervals `player-web`'s skin can draw (`SKIP_ICON_SECONDS`), and so the ones native offers.
private let skipIconSeconds = [5, 10, 30]

/// Rounds a requested skip onto the set the skin can draw, as `snapSkipSeconds` in `player-web`
/// does, so a button's label and its jump agree. Nil means no button.
public func snapSkipSeconds(_ seconds: Double) -> Int? {
    guard seconds.isFinite, seconds > 0 else { return nil }
    // `min(by:)` keeps the first of equals, so the smaller interval wins a tie.
    return skipIconSeconds.min { abs(Double($0) - seconds) < abs(Double($1) - seconds) }
}

/// What the lock screen and Control Center skip by, from ``CreateOptions``.
public struct SkinOptions: Equatable {
    public let skipBackSeconds: Double
    public let skipForwardSeconds: Double

    public init(skipBackSeconds: Double = 10, skipForwardSeconds: Double = 10) {
        self.skipBackSeconds = skipBackSeconds
        self.skipForwardSeconds = skipForwardSeconds
    }

    public var back: Int? { snapSkipSeconds(skipBackSeconds) }
    public var forward: Int? { snapSkipSeconds(skipForwardSeconds) }
}
