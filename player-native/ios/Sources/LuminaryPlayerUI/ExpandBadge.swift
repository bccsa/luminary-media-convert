#if canImport(UIKit)
import UIKit

/// The page's way up on a small picture in front: a dark round badge with a chevron, matching the one the page
/// draws over a cover. It takes no taps, so a tap reaches the page's own button underneath.
final class ExpandBadge: UIView {
    /// Its side, and its place from the picture's top-left corner, in points: the page's own badge.
    static let size: CGFloat = 24
    static let inset = CGPoint(x: 6, y: 10)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = UIColor.black.withAlphaComponent(0.55)
        layer.cornerRadius = Self.size / 2
        let chevron = UIImageView(
            image: UIImage(
                systemName: "chevron.up",
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)
            )
        )
        chevron.tintColor = .white
        chevron.contentMode = .center
        chevron.frame = CGRect(x: 0, y: 0, width: Self.size, height: Self.size)
        chevron.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(chevron)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
#endif
