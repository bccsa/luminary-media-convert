#if canImport(UIKit)
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The skin's measures and colours, taken from `player-web` at iPhone landscape size (plan 05).
enum Skin {
    /// The top row's buttons and the corner buttons.
    static let control: CGFloat = 44
    /// video.js draws an icon at 1.8 em: 0.875 rem → 25 pt.
    static let icon: CGFloat = 25
    static let play: CGFloat = 96
    /// 1.875 rem × 1.8.
    static let playIcon: CGFloat = 54
    static let skip: CGFloat = 56
    /// 1.25 rem × 1.8.
    static let skipIcon: CGFloat = 36
    /// The skip circles' centres sit this far either side of the play button's.
    static let skipOffset: CGFloat = 72
    /// …and this far above it (`translateY(-75%)` on a 56 pt circle).
    static let skipLift: CGFloat = 14
    static let progressHeight: CGFloat = 4
    static let knob: CGFloat = 12
    /// The progress bar's inset from the leading edge.
    static let progressInset: CGFloat = 18
    static let scrim = UIColor(white: 0, alpha: 0.3)
    static let progressTrack = UIColor(red: 115 / 255, green: 133 / 255, blue: 159 / 255, alpha: 0.5)
    static let progressLoaded = UIColor(red: 115 / 255, green: 133 / 255, blue: 159 / 255, alpha: 0.75)
    static let text = UIFont.systemFont(ofSize: 14)
    /// video.js's rate label: 1.5 em of 0.875 rem.
    static let rateText = UIFont.systemFont(ofSize: 21)
    static let showDuration: TimeInterval = 0.1
    static let hideDuration: TimeInterval = 1
}

/// A control drawn with a video.js glyph, or with text (the speed's `1x`).
final class GlyphButton: UIControl {
    private let shape = CAShapeLayer()
    private let label = UILabel()
    private let iconSize: CGFloat

    init(size: CGFloat, iconSize: CGFloat) {
        self.iconSize = iconSize
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        shape.fillColor = UIColor.white.cgColor
        shape.fillRule = .evenOdd
        layer.addSublayer(shape)
        label.textColor = .white
        label.font = Skin.rateText
        label.textAlignment = .center
        label.isHidden = true
        addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var glyph: VideoJsGlyph? {
        didSet {
            shape.path = glyph?.cgPath(size: iconSize)
            label.isHidden = true
            setNeedsLayout()
        }
    }

    var text: String? {
        didSet {
            label.text = text
            label.isHidden = text == nil
            shape.path = nil
        }
    }

    override var intrinsicContentSize: CGSize { bounds.size }

    override func layoutSubviews() {
        super.layoutSubviews()
        shape.frame = CGRect(
            x: (bounds.width - iconSize) / 2, y: (bounds.height - iconSize) / 2, width: iconSize, height: iconSize
        )
        label.frame = bounds
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
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

    static let width: CGFloat = 152
    static let itemHeight: CGFloat = 48

    init(items: [Item]) {
        super.init(frame: CGRect(x: 0, y: 0, width: Self.width, height: Self.itemHeight * CGFloat(items.count)))
        backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(0x52525B) : Self.rgb(0xFAFAFA) }
        layer.cornerRadius = 6
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.1
        layer.shadowRadius = 10
        layer.shadowOffset = CGSize(width: 0, height: 10)
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .custom)
            button.frame = CGRect(x: 0, y: CGFloat(index) * Self.itemHeight, width: Self.width, height: Self.itemHeight)
            button.contentHorizontalAlignment = .left
            button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 40)
            button.setTitle(item.title, for: .normal)
            button.titleLabel?.font = item.selected ? .boldSystemFont(ofSize: 16) : .systemFont(ofSize: 16)
            button.titleLabel?.lineBreakMode = .byTruncatingTail
            button.setTitleColor(UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(0xF1F5F9) : Self.rgb(0x18181B) }, for: .normal)
            if item.selected {
                // Three cues, so the choice in force reads at a glance and not by weight alone: a
                // yellow row, yellow text, and a check at the end of the row.
                let ink = UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(0xFACC15) : Self.rgb(0x854D0E) }
                button.backgroundColor = UIColor { $0.userInterfaceStyle == .dark
                    ? UIColor(red: 250 / 255, green: 204 / 255, blue: 21 / 255, alpha: 0.24)
                    : UIColor(red: 234 / 255, green: 179 / 255, blue: 8 / 255, alpha: 0.30) }
                button.setTitleColor(ink, for: .normal)
                let check = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .bold)))
                check.tintColor = ink
                check.contentMode = .center
                check.frame = CGRect(x: Self.width - 36, y: 0, width: 24, height: Self.itemHeight)
                check.isUserInteractionEnabled = false
                button.addSubview(check)
                button.accessibilityTraits.insert(.selected)
            }
            if index == 0 { button.layer.cornerRadius = 6; button.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner] }
            if index == items.count - 1 {
                button.layer.cornerRadius = 6
                button.layer.maskedCorners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner])
            }
            button.addAction(UIAction { _ in item.pick() }, for: .touchUpInside)
            addSubview(button)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private static func rgb(_ hex: Int) -> UIColor {
        UIColor(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
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
    /// Seconds a frame stands for; the held roster's step unless a pinned one asks for its own.
    private var step: Double?
    /// The pinned roster is dragged and tapped, and has a button to close it.
    var onPan: ((_ translationX: CGFloat, _ state: UIGestureRecognizer.State) -> Void)?
    var onTap: ((_ x: CGFloat) -> Void)?
    var onClose: (() -> Void)?
    private let closeButton = UIButton(type: .system)
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
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
        addGestureRecognizer(tap)
        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold)), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.55)
        closeButton.layer.cornerRadius = 16
        closeButton.isHidden = true
        closeButton.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        addSubview(closeButton)
    }

    /// Whether the roster takes the finger (pinned) or lets it through to the controls under it.
    func setInteractive(_ on: Bool, closeLabel: String = "") {
        isUserInteractionEnabled = on
        closeButton.isHidden = !on
        closeButton.accessibilityLabel = closeLabel
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        closeButton.frame = CGRect(x: bounds.maxX - 40, y: 8, width: 32, height: 32)
    }

    /// Points to the second at the roster's tile size and `step`, or nil until there are frames.
    func pointsPerSecond(step: Double) -> CGFloat? {
        guard let sample = frames?.sample(), step > 0 else { return nil }
        return max(24, bounds.height * CGFloat(sample.w) / CGFloat(max(sample.h, 1))) / CGFloat(step)
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        onPan?(pan.translation(in: self).x, pan.state)
    }

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        onTap?(tap.location(in: self).x)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ frames: Thumbnails?) {
        self.frames = frames
        decoded.removeAll()
    }

    func show(time: Double, markerX: CGFloat, duration: Double, step: Double? = nil) {
        self.time = time
        self.markerX = markerX
        self.duration = duration
        self.step = step
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
        let tileWidth = max(24, h * CGFloat(sample.w) / CGFloat(max(sample.h, 1)))
        let step = self.step ?? Roster.step(duration: duration)
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
        context.fill(CGRect(x: 0, y: h - 1, width: w, height: 1))
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
