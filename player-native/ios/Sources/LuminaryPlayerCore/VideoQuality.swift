import Foundation

/// The heights full-screen's quality menu offers, from the stream's variants: each once, the tallest first, and none
/// worth a menu when there is only one.
public enum VideoQuality {
    public static func choices(heights: [Double]) -> [Int] {
        let offered = Set(heights.compactMap { $0.isFinite && $0 > 0 ? Int($0.rounded()) : nil })
        return offered.count > 1 ? offered.sorted(by: >) : []
    }

    /// "720p", as the web's and Android's menus name a height.
    public static func label(_ height: Int) -> String { "\(height)p" }
}
