import CoreGraphics
import Testing
import LuminaryPlayerCore

/// The Video.js 10 icons are SVG on an 18-unit grid; the parser has to read every command they use.
@Suite("Video.js 10 icons")
struct V10IconsTests {
    private let all: [(String, [V10Icons.Layer])] = [
        ("play", V10Icons.play), ("pause", V10Icons.pause), ("volumeOff", V10Icons.volumeOff),
        ("volumeLow", V10Icons.volumeLow), ("volumeHigh", V10Icons.volumeHigh), ("quality", V10Icons.quality),
        ("speech", V10Icons.speech), ("speed", V10Icons.speed), ("captions", V10Icons.captions),
        ("cast", V10Icons.cast), ("pip", V10Icons.pip), ("fullscreenExit", V10Icons.fullscreenExit),
        ("check", V10Icons.check),
    ]

    @Test("every icon draws something, inside its grid")
    func drawsInsideGrid() {
        let grid = CGRect(x: -1, y: -1, width: V10Icons.grid + 2, height: V10Icons.grid + 2)
        for (name, layers) in all {
            #expect(!layers.isEmpty, "\(name) has layers")
            for layer in layers {
                let box = svgPath(layer.path).boundingBoxOfPath
                #expect(!box.isNull && box.width > 0 && box.height > 0, "\(name) draws")
                #expect(grid.contains(box), "\(name) stays inside the grid")
            }
        }
    }

    @Test("relative commands move from the current point")
    func relative() {
        let box = svgPath("M2 2h4v4h-4z").boundingBoxOfPath
        #expect(box == CGRect(x: 2, y: 2, width: 4, height: 4))
    }

    @Test("an arc is drawn: a half circle of radius 4 spans eight units")
    func arc() {
        let box = svgPath("M0 4A4 4 0 0 1 8 4").boundingBoxOfPath
        #expect(abs(box.width - 8) < 0.01)
        #expect(abs(box.height - 4) < 0.01)
    }

    @Test("the skip arc's compact flags and signs parse")
    func skipArc() {
        let box = svgPath("M20.5 12a8.5 8.5 0 1 1-2.9-6.4").boundingBoxOfPath
        #expect(box.width > 5 && box.height > 10)
    }
}
