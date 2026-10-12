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

/// SVG path data → `CGPath`: every command, absolute and relative (M L H V C S Q T A Z), which the
/// Video.js 10 icons use as well as the icon font's absolute ones. Repeated coordinate sets continue
/// the last command, as SVG says.
public func svgPath(_ data: String) -> CGPath {
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
        let relative = command.isLowercase
        let origin = relative ? current : .zero
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x, y: origin.y + y) }
        switch command.uppercased() {
        case "M":
            guard let v = tokens.numbers(2) else { return path }
            current = point(v[0], v[1])
            start = current
            path.move(to: current)
            command = relative ? "l" : "L" // Pairs after a move are lines.
            lastCubic = nil; lastQuad = nil
        case "L":
            guard let v = tokens.numbers(2) else { return path }
            current = point(v[0], v[1])
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "H":
            guard let v = tokens.number() else { return path }
            current = CGPoint(x: relative ? current.x + v : v, y: current.y)
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "V":
            guard let v = tokens.number() else { return path }
            current = CGPoint(x: current.x, y: relative ? current.y + v : v)
            path.addLine(to: current)
            lastCubic = nil; lastQuad = nil
        case "C":
            guard let v = tokens.numbers(6) else { return path }
            let c1 = point(v[0], v[1]), c2 = point(v[2], v[3])
            current = point(v[4], v[5])
            path.addCurve(to: current, control1: c1, control2: c2)
            lastCubic = c2; lastQuad = nil
        case "S":
            guard let v = tokens.numbers(4) else { return path }
            let c1 = lastCubic.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
            let c2 = point(v[0], v[1])
            current = point(v[2], v[3])
            path.addCurve(to: current, control1: c1, control2: c2)
            lastCubic = c2; lastQuad = nil
        case "Q":
            guard let v = tokens.numbers(4) else { return path }
            let control = point(v[0], v[1])
            current = point(v[2], v[3])
            path.addQuadCurve(to: current, control: control)
            lastQuad = control; lastCubic = nil
        case "T":
            guard let v = tokens.numbers(2) else { return path }
            let control = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
            current = point(v[0], v[1])
            path.addQuadCurve(to: current, control: control)
            lastQuad = control; lastCubic = nil
        case "A":
            guard let v = tokens.numbers(7) else { return path }
            let end = point(v[5], v[6])
            addArc(to: path, from: current, rx: v[0], ry: v[1], rotation: v[2], large: v[3] != 0, sweep: v[4] != 0, end: end)
            current = end
            lastCubic = nil; lastQuad = nil
        default:
            // A command SVG does not have: stop rather than draw something wrong.
            return path
        }
    }
    return path
}

/// An SVG elliptical arc as cubic curves (SVG 1.1 implementation notes, F.6).
private func addArc(
    to path: CGMutablePath, from p0: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotation: CGFloat,
    large: Bool, sweep: Bool, end p1: CGPoint
) {
    var rx = abs(rxIn), ry = abs(ryIn)
    guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
    let phi = rotation * .pi / 180
    let cosPhi = cos(phi), sinPhi = sin(phi)
    let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
    let x1 = cosPhi * dx + sinPhi * dy
    let y1 = -sinPhi * dx + cosPhi * dy
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lambda > 1 {
        let root = lambda.squareRoot()
        rx *= root
        ry *= root
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var factor = denominator == 0 ? 0 : (max(numerator, 0) / denominator).squareRoot()
    if large == sweep { factor = -factor }
    let cxp = factor * rx * y1 / ry
    let cyp = -factor * ry * x1 / rx
    let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
    let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
        let sign: CGFloat = ux * vy - uy * vx < 0 ? -1 : 1
        let dot = (ux * vx + uy * vy) / ((ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot())
        return sign * acos(min(max(dot, -1), 1))
    }
    let theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
    var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
    if !sweep, delta > 0 { delta -= 2 * .pi }
    if sweep, delta < 0 { delta += 2 * .pi }
    let segments = max(Int((abs(delta) / (.pi / 2)).rounded(.up)), 1)
    let step = delta / CGFloat(segments)
    let k = 4 / 3 * tan(step / 4)
    var theta = theta1
    for _ in 0..<segments {
        let c1 = cos(theta), s1 = sin(theta)
        let c2 = cos(theta + step), s2 = sin(theta + step)
        func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: cosPhi * rx * x - sinPhi * ry * y + cx, y: sinPhi * rx * x + cosPhi * ry * y + cy)
        }
        path.addCurve(
            to: map(c2, s2), control1: map(c1 - k * s1, s1 + k * c1), control2: map(c2 + k * s2, s2 - k * c2)
        )
        theta += step
    }
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
