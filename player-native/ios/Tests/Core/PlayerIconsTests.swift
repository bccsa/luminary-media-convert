import CoreGraphics
import Testing
import LuminaryPlayerCore

@Suite("Player icons")
struct PlayerIconsTests {
    @Test("every icon draws something, inside its grid")
    func drawsInsideGrid() {
        let grid = CGRect(x: -1, y: -1, width: V10Icons.grid + 2, height: V10Icons.grid + 2)
        let all = [
            ("audioLanguage", PlayerIcons.audioLanguage), ("captionsCc", PlayerIcons.captionsCc),
            ("captionsCcOn", PlayerIcons.captionsCcOn),
        ]
        for (name, layers) in all {
            #expect(!layers.isEmpty, "\(name) has layers")
            for layer in layers {
                let box = svgPath(layer.path).boundingBoxOfPath
                #expect(!box.isNull && box.width > 0 && box.height > 0, "\(name) draws")
                #expect(grid.contains(box), "\(name) stays inside the grid")
            }
        }
    }

    /// The shape layer fills nonzero, so the letters have to wind against the box to show through it.
    @Test("the filled CC's letters are holes in its box")
    func lettersCutOut() {
        let path = svgPath(PlayerIcons.captionsCcOn[0].path)
        // In the box, clear of the letters.
        #expect(path.contains(CGPoint(x: 1, y: 9), using: .winding))
        #expect(path.contains(CGPoint(x: 9, y: 3), using: .winding))
        // On the left stroke of each C, which the outline icon's letters fill.
        let letters = svgPath(PlayerIcons.captionsCc[1].path)
        for point in [CGPoint(x: 3.6, y: 9), CGPoint(x: 9.95, y: 9)] {
            #expect(letters.contains(point, using: .winding))
            #expect(!path.contains(point, using: .winding))
        }
    }
}
