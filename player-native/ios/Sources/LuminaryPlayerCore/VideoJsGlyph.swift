import CoreGraphics
import Foundation

/// One glyph of video.js's icon font (``VideoJsIcons``), drawn as a path.
public struct VideoJsGlyph: Sendable {
    /// Width in font units; most glyphs are one em.
    public let advance: Double
    /// SVG path data in font units, y upwards.
    public let path: String

    /// The glyph in a square of `size` points, y downwards, as CSS draws a font glyph of that
    /// size: one em is `size`, centred horizontally on its advance.
    public func cgPath(size: CGFloat) -> CGPath {
        let scale = size / CGFloat(VideoJsIcons.unitsPerEm)
        let em = CGFloat(VideoJsIcons.unitsPerEm)
        let shift = (em - CGFloat(advance)) / 2
        var transform = CGAffineTransform(a: scale, b: 0, c: 0, d: -scale, tx: shift * scale, ty: size)
        return svgPath(path).copy(using: &transform) ?? CGMutablePath()
    }
}

/// SVG path data → `CGPath`, for the absolute commands the icon font uses: M L H V C S Q T Z.
/// Repeated coordinate pairs continue the last command, as SVG says.
func svgPath(_ data: String) -> CGPath {
    let path = CGMutablePath()
    var tokens = SvgTokens(data)
    var command: Character = "M"
    var current = CGPoint.zero
    var start = CGPoint.zero
    // The last control point, for the smooth commands S and T.
    var lastCubic: CGPoint?
    var lastQuad: CGPoint?

    while let token = tokens.next() {
        if case .command(let c) = token {
            command = c
            if c == "Z" || c == "z" {
                path.closeSubpath()
                current = start
                lastCubic = nil
                lastQuad = nil
            }
            continue
        }
        tokens.pushBack(token)
        guard let first = tokens.number() else { break }
        switch command {
        case "M":
            guard let y = tokens.number() else { break }
            current = CGPoint(x: first, y: y)
            start = current
            path.move(to: current)
            command = "L" // Pairs after a move are lines.
            lastCubic = nil; lastQuad = nil
        case "L":
            guard let y = tokens.number() else { break }
            current = CGPoint(x: first, y: y)
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "H":
            current = CGPoint(x: first, y: current.y)
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "V":
            current = CGPoint(x: current.x, y: first)
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "C":
            guard let values = tokens.numbers(5) else { break }
            let c1 = CGPoint(x: first, y: values[0]), c2 = CGPoint(x: values[1], y: values[2])
            current = CGPoint(x: values[3], y: values[4])
            path.addCurve(to: current, control1: c1, control2: c2)
            lastCubic = c2; lastQuad = nil
        case "S":
            guard let values = tokens.numbers(3) else { break }
            let c1 = lastCubic.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
            let c2 = CGPoint(x: first, y: values[0])
            current = CGPoint(x: values[1], y: values[2])
            path.addCurve(to: current, control1: c1, control2: c2)
            lastCubic = c2; lastQuad = nil
        case "Q":
            guard let values = tokens.numbers(3) else { break }
            let control = CGPoint(x: first, y: values[0])
            current = CGPoint(x: values[1], y: values[2])
            path.addQuadCurve(to: current, control: control)
            lastQuad = control; lastCubic = nil
        case "T":
            guard let y = tokens.number() else { break }
            let control = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
            current = CGPoint(x: first, y: y)
            path.addQuadCurve(to: current, control: control)
            lastQuad = control; lastCubic = nil
        default:
            // A command the icon font does not use: stop rather than draw something wrong.
            return path
        }
    }
    return path
}

private struct SvgTokens {
    enum Token {
        case command(Character)
        case number(Double)
    }

    private let scalars: [Character]
    private var index = 0
    private var pushed: Token?

    init(_ text: String) {
        scalars = Array(text)
    }

    mutating func pushBack(_ token: Token) {
        pushed = token
    }

    mutating func number() -> CGFloat? {
        guard case .number(let value) = next() else { return nil }
        return CGFloat(value)
    }

    mutating func numbers(_ count: Int) -> [CGFloat]? {
        var values: [CGFloat] = []
        for _ in 0..<count {
            guard let value = number() else { return nil }
            values.append(value)
        }
        return values
    }

    mutating func next() -> Token? {
        if let token = pushed {
            pushed = nil
            return token
        }
        while index < scalars.count, scalars[index] == " " || scalars[index] == "," || scalars[index] == "\n" {
            index += 1
        }
        guard index < scalars.count else { return nil }
        let c = scalars[index]
        if c.isLetter, c != "e", c != "E" {
            index += 1
            return .command(c)
        }
        let begin = index
        index += 1
        while index < scalars.count {
            let next = scalars[index]
            let previous = scalars[index - 1]
            if next.isNumber || next == "." && !scalars[begin..<index].contains(".")
                || (next == "-" || next == "+") && (previous == "e" || previous == "E")
                || next == "e" || next == "E" {
                index += 1
            } else {
                break
            }
        }
        return Double(String(scalars[begin..<index])).map(Token.number)
    }
}
