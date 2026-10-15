/// Glyphs for the chapters / up-next panel, drawn on ``V10Icons``' 18-unit grid in the same layers. The same
/// paths as Android's `BrowseIcons`.
public enum BrowseIcons {
    /// Three rows, each a bullet and a line.
    public static let list: [V10Icons.Layer] = [
        .init(path: "M3 3.25a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", alpha: 1, strokeWidth: 0),
        .init(path: "M3 7.75a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", alpha: 1, strokeWidth: 0),
        .init(path: "M3 12.25a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", alpha: 1, strokeWidth: 0),
        .init(path: "M7.5 3.6h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", alpha: 1, strokeWidth: 0),
        .init(path: "M7.5 8.1h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", alpha: 1, strokeWidth: 0),
        .init(path: "M7.5 12.6h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", alpha: 1, strokeWidth: 0),
    ]

    public static let close: [V10Icons.Layer] = [
        .init(path: "M4.5 4.5l9 9M13.5 4.5l-9 9", alpha: 1, strokeWidth: 2),
    ]
}
