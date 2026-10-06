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

    static let width: CGFloat = 140
    static let itemHeight: CGFloat = 44

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
            button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            button.setTitle(item.title, for: .normal)
            button.titleLabel?.font = item.selected ? .boldSystemFont(ofSize: 14) : Skin.text
            button.setTitleColor(UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(0xF1F5F9) : Self.rgb(0x18181B) }, for: .normal)
            if item.selected {
                button.backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? Self.rgb(0x71717A) : Self.rgb(0xD4D4D8) }
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
#endif
