import CoreGraphics
import Testing
@testable import LuminaryPlayerCore

@Suite("video.js glyphs as paths")
struct VideoJsGlyphTests {
    private let glyphs: [(String, VideoJsGlyph)] = [
        ("play", VideoJsIcons.play), ("pause", VideoJsIcons.pause),
        ("replay5", VideoJsIcons.replay5), ("replay10", VideoJsIcons.replay10), ("replay30", VideoJsIcons.replay30),
        ("forward5", VideoJsIcons.forward5), ("forward10", VideoJsIcons.forward10), ("forward30", VideoJsIcons.forward30),
        ("fullscreenExit", VideoJsIcons.fullscreenExit), ("pictureInPictureEnter", VideoJsIcons.pictureInPictureEnter),
        ("audio", VideoJsIcons.audio), ("subtitles", VideoJsIcons.subtitles),
        ("volumeMute", VideoJsIcons.volumeMute), ("volumeHigh", VideoJsIcons.volumeHigh),
    ]

    @Test("every glyph draws inside its square, and draws something")
    func inSquare() {
        for (name, glyph) in glyphs {
            let box = glyph.cgPath(size: 100).boundingBoxOfPath
            #expect(box.width > 20 && box.height > 20, "\(name) is empty: \(box)")
            #expect(box.minX >= -0.5 && box.minY >= -0.5 && box.maxX <= 100.5 && box.maxY <= 100.5, "\(name) leaves its square: \(box)")
        }
    }

    @Test("parses absolute commands, repeated pairs and closes")
    func parses() {
        let path = svgPath("M0 0L10 0 10 10H0V5Z")
        #expect(path.boundingBoxOfPath == CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    @Test("flips y: a glyph's top in font units is the top of the square")
    func flips() {
        let glyph = VideoJsGlyph(advance: VideoJsIcons.unitsPerEm, path: "M0 1792L1792 1792 1792 1344Z")
        let box = glyph.cgPath(size: 100).boundingBoxOfPath
        #expect(abs(box.minY) < 0.001 && abs(box.maxY - 25) < 0.001)
    }
}
