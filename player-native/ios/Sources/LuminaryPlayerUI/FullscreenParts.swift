#if canImport(UIKit)
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The skin's measures and colours, taken from `player-web` at iPhone landscape size (plan 05).
enum Skin {
    /// video.js draws an icon at 1.8 em: 0.875 rem → 25 pt.
    static let icon: CGFloat = 22
    /// The Video.js 10 centre cluster: play 80, the skips 56 round, 32 between the parts, on one line.
    static let play: CGFloat = 80
    static let playIcon: CGFloat = 38
    static let skip: CGFloat = 56
    static let skipIcon: CGFloat = 32
    static let clusterGap: CGFloat = 32
    /// The skip circles' centres sit this far either side of the play button's.
    static let skipOffset: CGFloat = play / 2 + clusterGap + skip / 2
    static let skipLift: CGFloat = 0
    /// `--lmpl-s`: one up to 900 pt wide, then 1.25, then 1.6, so the controls are not a stamp on an iPad.
    static func scale(forWidth width: CGFloat) -> CGFloat { width >= 1400 ? 1.6 : width >= 900 ? 1.25 : 1 }
    /// `--lmpl-edge`: how far the controls keep in from the sides.
    static func edge(forWidth width: CGFloat) -> CGFloat {
        if width >= 1400 { return min(max(width * 0.06, 56), 200) }
        if width >= 900 { return min(max(width * 0.05, 32), 110) }
        return min(max(width * 0.05, 20), 64)
    }
    /// The bottom row's buttons, before scaling.
    static let rowButton: CGFloat = 40
    /// The timeline row: tall enough to hit, the track drawn in its middle.
    static let timelineRow: CGFloat = 30
    /// The track at rest, and while held or resting on the frames.
    static let track: CGFloat = 12
    static let trackHeld: CGFloat = 16
    /// How far the held track's bottom sits above the row's: the row lifts by the frames' height less this.
    static let trackInset: CGFloat = 7
    /// The column the controls stand in: room above them for the fade, and below them to the edge.
    static let columnTop: CGFloat = 12 + 72
    static let columnBottom: CGFloat = 14
    /// The gap the elapsed and remaining times keep from the bar.
    static let timeGap: CGFloat = 12
    /// The fade the controls stand on: dark at the foot of the picture, clear above it.
    static let fadeColors = [UIColor(white: 0, alpha: 0.75), UIColor(white: 0, alpha: 0.4), UIColor(white: 0, alpha: 0)]
    /// The track, what is loaded, and what has played.
    static let trackColor = UIColor(white: 1, alpha: 0.26)
    static let loadedColor = UIColor(white: 1, alpha: 0.4)
    static let fadeLocations: [NSNumber] = [0, 0.55, 1]
    static let text = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    /// video.js's rate label: 1.5 em of 0.875 rem.
    static let rateText = UIFont.systemFont(ofSize: 21)
    static let showDuration: TimeInterval = 0.1
    static let hideDuration: TimeInterval = 0.5
}

/// A label with room around its text, drawn as the Video.js 10 time pill: dark glass, a thin light edge.
final class PillLabel: UILabel {
    private let inset = UIEdgeInsets(top: 4, left: 11, bottom: 4, right: 11)

    override init(frame: CGRect) {
        super.init(frame: frame)
        font = .systemFont(ofSize: 14, weight: .medium)
        textColor = .white
        textAlignment = .center
        backgroundColor = UIColor(red: 20 / 255, green: 20 / 255, blue: 24 / 255, alpha: 0.72)
        layer.borderWidth = 1
        layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
        layer.masksToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
    }

    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: inset)) }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + inset.left + inset.right, height: size.height + inset.top + inset.bottom)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { intrinsicContentSize }
}

/// The foot-of-picture fade behind the bottom controls.
final class FadeView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    /// From the bottom edge up, under the controls; `fromTop`, the lighter fade down from the top edge under the top line.
    init(fromTop: Bool = false) {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        let gradient = layer as! CAGradientLayer
        if fromTop {
            gradient.startPoint = CGPoint(x: 0.5, y: 0)
            gradient.endPoint = CGPoint(x: 0.5, y: 1)
            gradient.colors = [UIColor(white: 0, alpha: 0.5), UIColor(white: 0, alpha: 0.2), UIColor(white: 0, alpha: 0)].map(\.cgColor)
            gradient.locations = [0, 0.5, 1]
        } else {
            gradient.startPoint = CGPoint(x: 0.5, y: 1)
            gradient.endPoint = CGPoint(x: 0.5, y: 0)
            gradient.colors = Skin.fadeColors.map(\.cgColor)
            gradient.locations = Skin.fadeLocations
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// A control drawn with a Video.js 10 icon: its path layers on an 18-unit grid, or the skip glyph
/// (an arc, an arrowhead and the seconds), in a round dark button when `circle`. Pressing shrinks it a
/// touch, as the web's does.
final class GlyphButton: UIControl {
    private let backing = CAShapeLayer()
    private let icon = CALayer()
    private let seconds = UILabel()
    private let iconSize: CGFloat

    init(size: CGFloat, iconSize: CGFloat, circle: Bool = false) {
        self.iconSize = iconSize
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        if circle {
            backing.fillColor = UIColor(red: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 0.58).cgColor
            backing.strokeColor = UIColor(white: 1, alpha: 0.18).cgColor
            backing.lineWidth = 1
            layer.addSublayer(backing)
        }
        // Legible over any picture, as the skin's drop shadow makes it.
        icon.shadowColor = UIColor.black.cgColor
        icon.shadowOpacity = 0.6
        icon.shadowRadius = iconSize * 0.05
        icon.shadowOffset = CGSize(width: 0, height: iconSize * 0.04)
        layer.addSublayer(icon)
        seconds.textColor = .white
        seconds.textAlignment = .center
        seconds.isHidden = true
        addSubview(seconds)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// A Video.js 10 icon, on its 18-unit grid. Setting one takes the skip glyph away.
    var layers: [V10Icons.Layer]? {
        didSet {
            guard layers != oldValue else { return }
            if layers != nil { skipGlyph = nil }
            rebuild()
        }
    }

    /// The skip glyph, on a 24-unit grid: `skipIcon` in `controlsHtml.ts`. Setting one takes the icon away.
    var skip: (seconds: Int, forward: Bool)? {
        get { skipGlyph }
        set {
            guard newValue?.seconds != skipGlyph?.seconds || newValue?.forward != skipGlyph?.forward else { return }
            skipGlyph = newValue
            layers = nil
            rebuild()
        }
    }
    private var skipGlyph: (seconds: Int, forward: Bool)?

    private func rebuild() {
        icon.sublayers?.forEach { $0.removeFromSuperlayer() }
        seconds.isHidden = true
        if let layers {
            let unit = iconSize / CGFloat(V10Icons.grid)
            for item in layers {
                icon.addSublayer(shape(item.path, unit: unit, alpha: item.alpha, stroke: item.strokeWidth))
            }
        } else if let skip = skipGlyph {
            let unit = iconSize / 24
            let arc = skip.forward ? "M20.5 12a8.5 8.5 0 1 1-2.9-6.4" : "M3.5 12a8.5 8.5 0 1 0 2.9-6.4"
            let head = skip.forward ? "M20.8 4.2v4.4h-4.4" : "M3.2 4.2v4.4h4.4"
            icon.addSublayer(shape(arc, unit: unit, alpha: 1, stroke: 1.8))
            icon.addSublayer(shape(head, unit: unit, alpha: 1, stroke: 1.8))
            seconds.text = "\(skip.seconds)"
            seconds.font = .systemFont(ofSize: (skip.seconds >= 100 ? 6 : 7.5) * unit, weight: .bold)
            seconds.isHidden = false
        }
        setNeedsLayout()
    }

    private func shape(_ data: String, unit: CGFloat, alpha: Double, stroke: Double) -> CAShapeLayer {
        let layer = CAShapeLayer()
        var transform = CGAffineTransform(scaleX: unit, y: unit)
        layer.path = svgPath(data).copy(using: &transform)
        if stroke > 0 {
            layer.fillColor = nil
            layer.strokeColor = UIColor(white: 1, alpha: alpha).cgColor
            layer.lineWidth = stroke * unit
            layer.lineCap = .round
            layer.lineJoin = .round
        } else {
            layer.fillColor = UIColor(white: 1, alpha: alpha).cgColor
        }
        return layer
    }

    var text: String?

    override var intrinsicContentSize: CGSize { bounds.size }

    override func layoutSubviews() {
        super.layoutSubviews()
        icon.frame = CGRect(
            x: (bounds.width - iconSize) / 2, y: (bounds.height - iconSize) / 2, width: iconSize, height: iconSize
        )
        let side = min(bounds.width, bounds.height) - 2
        backing.path = CGPath(ellipseIn: CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side), transform: nil)
        // The seconds sit a little below the middle of the arc, where the skip glyph keeps them.
        let unit = iconSize / 24
        seconds.sizeToFit()
        seconds.center = CGPoint(x: bounds.midX, y: icon.frame.minY + 12.6 * unit)
    }

    override var isHighlighted: Bool {
        didSet {
            UIView.animate(withDuration: 0.12) { self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.94, y: 0.94) : .identity }
        }
    }
}

/// The buffering spinner (native only): a white ring turning in play/pause's place.
final class SpinnerView: UIView {
    private let ring = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        ring.strokeColor = UIColor.white.cgColor
        ring.fillColor = nil
        ring.lineWidth = 4
        ring.lineCap = .round
        ring.strokeEnd = 0.75
        layer.addSublayer(ring)
        isUserInteractionEnabled = false
        // Its label ("Loading") is all VoiceOver has while play/pause is hidden behind it.
        isAccessibilityElement = true
        accessibilityTraits = .updatesFrequently
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height) * 0.6
        ring.frame = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        ring.path = UIBezierPath(ovalIn: ring.bounds.insetBy(dx: 2, dy: 2)).cgPath
    }

    override var isHidden: Bool {
        didSet { isHidden ? ring.removeAllAnimations() : spin() }
    }

    private func spin() {
        guard ring.animation(forKey: "spin") == nil else { return }
        let animation = CABasicAnimation(keyPath: "transform.rotation")
        animation.fromValue = 0
        animation.toValue = 2 * Double.pi
        animation.duration = 1
        animation.repeatCount = .infinity
        ring.add(animation, forKey: "spin")
    }
}

/// A video.js popup menu, in the skin's light style: `#fafafa`, items 12 pt in, 14 pt text, the
/// selected item `#d4d4d8` and bold. Dark in dark mode, as the web is under a `.dark` host.
final class FullscreenMenu: UIView {
    struct Item {
        let title: String
        let selected: Bool
        let pick: () -> Void
    }

    /// The Video.js 10 card: dark, 168 wide, a small heading, rows 40 tall with the choice in force
    /// lifted and ticked. The same as Android's.
    static let width: CGFloat = 168
    static let itemHeight: CGFloat = 40
    private static let pad: CGFloat = 4
    private static let headerHeight: CGFloat = 26

    init(title: String? = nil, items: [Item]) {
        let header = title == nil ? 0 : Self.headerHeight
        super.init(frame: CGRect(x: 0, y: 0, width: Self.width, height: Self.pad * 2 + header + Self.itemHeight * CGFloat(items.count)))
        backgroundColor = UIColor(red: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 0.97)
        layer.cornerRadius = 14
        layer.borderWidth = 1
        layer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 10
        layer.shadowOffset = CGSize(width: 0, height: 6)
        var top = Self.pad
        if let title {
            let heading = UILabel(frame: CGRect(x: Self.pad + 10, y: top, width: Self.width - 2 * Self.pad - 20, height: Self.headerHeight))
            heading.attributedText = NSAttributedString(string: title.uppercased(), attributes: [
                .font: UIFont.systemFont(ofSize: 11, weight: .bold),
                .kern: 0.66,
                .foregroundColor: UIColor(white: 1, alpha: 0.6),
            ])
            heading.isAccessibilityElement = false
            addSubview(heading)
            top += Self.headerHeight
        }
        let rowWidth = Self.width - 2 * Self.pad
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .custom)
            button.frame = CGRect(x: Self.pad, y: top + CGFloat(index) * Self.itemHeight, width: rowWidth, height: Self.itemHeight)
            button.contentHorizontalAlignment = .left
            button.contentEdgeInsets = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 36)
            button.setTitle(item.title, for: .normal)
            button.titleLabel?.font = item.selected ? .boldSystemFont(ofSize: 14) : .systemFont(ofSize: 14)
            button.titleLabel?.lineBreakMode = .byTruncatingTail
            button.setTitleColor(.white, for: .normal)
            button.layer.cornerRadius = 9
            if item.selected {
                button.backgroundColor = UIColor(white: 1, alpha: 0.12)
                let check = GlyphButton(size: 18, iconSize: 18)
                check.layers = V10Icons.check
                check.isAccessibilityElement = false
                check.frame = CGRect(x: rowWidth - 28, y: (Self.itemHeight - 18) / 2, width: 18, height: 18)
                check.isUserInteractionEnabled = false
                button.addSubview(check)
                button.accessibilityTraits.insert(.selected)
            }
            button.addAction(UIAction { _ in item.pick() }, for: .touchUpInside)
            addSubview(button)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// The frames under a held timeline: a strip that slides past a marker kept under the finger, with
/// those further from it falling away into the dark, so it reads as a lens on the playhead. Drawn
/// from ``Thumbnails``' sheets; a frame whose sheet has not arrived is left dark. The same strip as
/// Android's `RosterView`.
final class RosterView: UIView {
    private var frames: Thumbnails?
    private var time: Double = 0
    private var markerX: CGFloat = 0
    private var duration: Double = 0
    /// The pinned roster is dragged: the slow scrub.
    var onPan: ((_ translationX: CGFloat, _ state: UIGestureRecognizer.State) -> Void)?
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
    /// The frames' height, which sets their width; the strip itself reaches further, down over the buttons.
    var tileHeight: CGFloat = 0 {
        didSet { if tileHeight != oldValue { setNeedsDisplay() } }
    }
    /// Decoded sheets, by address; the data itself lives in ``Thumbnails``' own cache.
    private var decoded: [String: CGImage] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(red: 11 / 255, green: 11 / 255, blue: 13 / 255, alpha: 1)
        isOpaque = true
        isUserInteractionEnabled = false
        clipsToBounds = true
        contentMode = .redraw
        addGestureRecognizer(pan)
    }

    /// Points to the second at the roster's tile size and `step`, or nil until there are frames.
    func pointsPerSecond(step: Double) -> CGFloat? {
        guard let sample = frames?.sample(), step > 0 else { return nil }
        return max(24, frameHeight * CGFloat(sample.w) / CGFloat(max(sample.h, 1))) / CGFloat(step)
    }

    private var frameHeight: CGFloat { tileHeight > 0 ? tileHeight : bounds.height
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        onPan?(pan.translation(in: self).x, pan.state)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ frames: Thumbnails?) {
        self.frames = frames
        decoded.removeAll()
    }

    func show(time: Double, markerX: CGFloat, duration: Double) {
        self.time = time
        self.markerX = markerX
        self.duration = duration
        setNeedsDisplay()
    }

    private func image(for cue: ThumbnailCue, in frames: Thumbnails) -> CGImage? {
        if let image = decoded[cue.url] { return image }
        guard let data = frames.sheet(for: cue), let image = UIImage(data: data)?.cgImage else { return nil }
        if decoded.count > 8 { decoded.removeAll() }
        decoded[cue.url] = image
        return image
    }

    override func draw(_ rect: CGRect) {
        guard let frames, let context = UIGraphicsGetCurrentContext(), let sample = frames.sample() else { return }
        let w = bounds.width
        let h = bounds.height
        let tileWidth = max(24, frameHeight * CGFloat(sample.w) / CGFloat(max(sample.h, 1)))
        let step = Roster.step(duration: duration)
        for tile in Roster.tiles(
            time: time, markerX: Double(markerX), width: Double(w), tileWidth: Double(tileWidth), step: step, duration: duration
        ) {
            let dst = CGRect(x: CGFloat(tile.left), y: 0, width: tileWidth, height: h)
            UIColor(red: 21 / 255, green: 21 / 255, blue: 24 / 255, alpha: 1).setFill()
            context.fill(dst)
            if let cue = frames.cue(at: tile.time), let sheet = image(for: cue, in: frames),
               let crop = sheet.cropping(to: CGRect(x: cue.x, y: cue.y, width: max(cue.w, 1), height: max(cue.h, 1))) {
                UIImage(cgImage: crop).draw(in: dst)
            }
            // A frame apart from its neighbour, without a gutter.
            UIColor(white: 0, alpha: 0.55).setFill()
            context.fill(CGRect(x: dst.maxX - 1, y: 0, width: 1, height: h))
        }
        // The frames nearest the marker are the ones that matter: the rest fall away.
        func at(_ x: CGFloat) -> CGFloat { min(max(x / w, 0), 1) }
        var stops: [CGFloat] = [0, at(markerX - 0.22 * w), at(markerX - 0.08 * w), at(markerX + 0.08 * w), at(markerX + 0.22 * w), 1]
        for i in 1..<stops.count { stops[i] = max(stops[i], stops[i - 1]) }
        let edge = UIColor(red: 8 / 255, green: 10 / 255, blue: 10 / 255, alpha: 0.78).cgColor
        let mid = UIColor(red: 8 / 255, green: 10 / 255, blue: 10 / 255, alpha: 0.35).cgColor
        let clear = UIColor(red: 8 / 255, green: 10 / 255, blue: 10 / 255, alpha: 0).cgColor
        if let shade = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [edge, mid, clear, clear, mid, edge] as CFArray, locations: stops
        ) {
            context.drawLinearGradient(shade, start: .zero, end: CGPoint(x: w, y: 0), options: [])
        }
        if let vertical = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [UIColor(white: 0, alpha: 0.28).cgColor, UIColor(white: 0, alpha: 0).cgColor,
                     UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.4).cgColor] as CFArray,
            locations: [0, 0.35, 0.7, 1]
        ) {
            context.drawLinearGradient(vertical, start: .zero, end: CGPoint(x: 0, y: h), options: [])
        }
        // A hairline of light where the timeline rests on the strip.
        UIColor(white: 1, alpha: 0.14).setFill()
        context.fill(CGRect(x: 0, y: 0, width: w, height: 1))
        // The marker: a rounded white bar with an outline and a glow.
        let bar: CGFloat = 3
        context.setFillColor(UIColor(white: 0, alpha: 0.4).cgColor)
        context.addPath(CGPath(roundedRect: CGRect(x: markerX - bar / 2 - 1, y: 0, width: bar + 2, height: h), cornerWidth: bar, cornerHeight: bar, transform: nil))
        context.fillPath()
        context.setShadow(offset: .zero, blur: 14, color: UIColor(white: 1, alpha: 0.55).cgColor)
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(CGPath(roundedRect: CGRect(x: markerX - bar / 2, y: 0, width: bar, height: h), cornerWidth: bar / 2, cornerHeight: bar / 2, transform: nil))
        context.fillPath()
    }
}
#endif
