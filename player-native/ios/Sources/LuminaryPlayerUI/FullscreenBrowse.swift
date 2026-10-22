#if canImport(UIKit)
import ImageIO
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The panel's and the strip's measures and colours: the same as Android's `SkinControls`.
enum BrowseSkin {
    static let sheet = UIColor(red: 18 / 255, green: 18 / 255, blue: 22 / 255, alpha: 0.95)
    static let scrim = UIColor(white: 0, alpha: 0.3)
    static let selectedRow = UIColor(white: 1, alpha: 0.15)
    static let divider = UIColor(white: 1, alpha: 0.12)
    static let secondary = UIColor(white: 1, alpha: 0.6)
    static let tile = UIColor(red: 21 / 255, green: 21 / 255, blue: 24 / 255, alpha: 1)
    static let tileEdge = UIColor(white: 1, alpha: 0.16)
    /// A third of a landscape screen is enough for a list; a portrait one needs nearly all of its width.
    static let widthFraction: CGFloat = 0.4
    static let minWidth: CGFloat = 320
    static let upNextPicture: CGFloat = 128
    static let stripDuration: TimeInterval = 0.25
}

/// A section name: small, bold capitals, spaced out a little.
private func sectionText(_ text: String, size: CGFloat, color: UIColor) -> NSAttributedString {
    NSAttributedString(string: text.uppercased(), attributes: [
        .font: PlayerFont.weight(.bold, size: size),
        .kern: size * 0.06,
        .foregroundColor: color,
    ])
}

/// The pictures of the up-next cards and rows: an address, a `data:` URL, or a path of the app's own files (the
/// stand-in pictures it ships, which the packaged app keeps under `public/`). Fetched off the main thread, shrunk
/// to the width they are drawn at, and kept for the next time a list opens. A card whose picture does not load
/// keeps its plain tile and still names the video.
enum FrameImages {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 24
        return cache
    }()
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 10
        return URLSession(configuration: configuration)
    }()
    private static let maxBytes = 8 * 1024 * 1024

    /// Calls `done` on the main thread with `url`'s picture, else `fallback`'s, else nil.
    static func load(_ url: String?, fallback: String?, width: CGFloat, done: @escaping (UIImage?) -> Void) {
        let candidates = [url, fallback].compactMap { $0?.isEmpty == false ? $0 : nil }
        guard let first = candidates.first else { return done(nil) }
        // Sharp at the size drawn, not larger.
        let pixels = max(Int(width * UIScreen.main.scale), 240)
        fetch(first, pixels: pixels) { image in
            if image == nil, candidates.count > 1 {
                fetch(candidates[1], pixels: pixels, done: done)
            } else {
                done(image)
            }
        }
    }

    private static func fetch(_ address: String, pixels: Int, done: @escaping (UIImage?) -> Void) {
        let key = "\(pixels)|\(address)" as NSString
        if let cached = cache.object(forKey: key) { return done(cached) }
        let finish: (Data?) -> Void = { data in
            let image = data.flatMap { downsample($0, pixels: pixels) }
            if let image { cache.setObject(image, forKey: key) }
            DispatchQueue.main.async { done(image) }
        }
        // `/assets/x.webp`: a path on the app's own origin, which the packaged app serves from `public/`.
        if address.hasPrefix("/"), !address.hasPrefix("//") {
            let file = Bundle.main.resourceURL?.appendingPathComponent("public").appendingPathComponent(String(address.dropFirst()))
            DispatchQueue.global(qos: .utility).async { finish(file.flatMap { try? Data(contentsOf: $0) }) }
            return
        }
        guard let url = URL(string: address), ["https", "http", "data"].contains(url.scheme?.lowercased() ?? "") else {
            return DispatchQueue.main.async { done(nil) }
        }
        session.dataTask(with: url) { data, response, _ in
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) { return finish(nil) }
            guard let data, data.count <= maxBytes else { return finish(nil) }
            finish(data)
        }.resume()
    }

    private static func downsample(_ data: Data, pixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: pixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// Full-screen's chapters / up-next panel: a sheet at the trailing edge over a scrim, a tab for each list it has and
/// a close button. A chapter seeks; an up-next item goes to the page to play. Tapping the scrim puts it away.
final class BrowsePanel: UIView {
    enum Tab { case chapters, upNext }

    var onClose: (() -> Void)?
    var onChapter: ((BrowseChapter) -> Void)?
    var onUpNext: ((String) -> Void)?

    private let scrim = UIControl()
    private let sheet = UIView()
    private let header = UIView()
    private let divider = UIView()
    private let scroll = UIScrollView()
    private let list = UIView()
    private let closeButton = GlyphButton(size: 40, iconSize: 20)
    private var tabs: [(tab: Tab, button: UIButton)] = []
    private var chapterRows: [(row: UIControl, title: UILabel, marker: GlyphButton)] = []

    private var browse = Browse(chapters: [], upNext: [])
    private var texts = FullscreenTexts()
    private(set) var tab = Tab.chapters
    private var currentChapter: Int?
    private var guide: Double = 0
    private var scale: CGFloat = 1
    private static let underlineTag = 9
    /// Changes whenever the list is rebuilt, so a picture of a list that is gone is not drawn into the next.
    private var imageEpoch = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        scrim.backgroundColor = BrowseSkin.scrim
        scrim.isAccessibilityElement = false
        scrim.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        addSubview(scrim)
        sheet.backgroundColor = BrowseSkin.sheet
        sheet.layer.cornerRadius = 16
        sheet.layer.maskedCorners = [.layerMinXMinYCorner, .layerMinXMaxYCorner]
        sheet.layer.shadowColor = UIColor.black.cgColor
        sheet.layer.shadowOpacity = 0.4
        sheet.layer.shadowRadius = 12
        // VoiceOver stays in the panel while it is up, as it would in a sheet.
        sheet.accessibilityViewIsModal = true
        addSubview(sheet)
        sheet.addSubview(header)
        divider.backgroundColor = BrowseSkin.divider
        sheet.addSubview(divider)
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        sheet.addSubview(scroll)
        scroll.addSubview(list)
        closeButton.layers = BrowseIcons.close
        closeButton.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        header.addSubview(closeButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Fills the panel. Chapters open first when there are any; `keepScroll` holds the place of a list that is
    /// replaced while open.
    func show(_ browse: Browse, texts: FullscreenTexts, chapter: Int?, duration: Double, scale: CGFloat, keepScroll: Bool) {
        let previous = self.browse
        self.browse = browse
        self.texts = texts
        self.scale = scale
        currentChapter = chapter
        guide = max(browse.chapters.map(\.end).max() ?? 0, duration)
        closeButton.accessibilityLabel = texts.closeBrowse
        sheet.accessibilityLabel = texts.browse
        if !keepScroll || previous.isEmpty { tab = browse.chapters.isEmpty ? .upNext : .chapters }
        if browse.chapters.isEmpty { tab = .upNext } else if browse.upNext.isEmpty { tab = .chapters }
        render(keepScroll: keepScroll)
    }

    /// Follows the playhead from chapter to chapter while the chapters are open.
    func markChapter(_ index: Int?) {
        guard index != currentChapter else { return }
        currentChapter = index
        guard tab == .chapters else { return }
        for (i, row) in chapterRows.enumerated() { style(row, now: i == index) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrim.frame = bounds
        let width = max(bounds.width * BrowseSkin.widthFraction, min(BrowseSkin.minWidth * scale, bounds.width * 0.92))
        sheet.frame = CGRect(x: bounds.width - width, y: 0, width: width, height: bounds.height)
        sheet.layer.shadowPath = UIBezierPath(roundedRect: sheet.bounds, cornerRadius: 16).cgPath
        let insets = safeAreaInsets
        let headerHeight = 48 * scale
        header.frame = CGRect(x: 8, y: insets.top + 4, width: width - 8 - 4 - insets.right, height: headerHeight)
        var x: CGFloat = 0
        for (_, button) in tabs {
            button.sizeToFit()
            button.frame = CGRect(x: x, y: 0, width: button.bounds.width, height: headerHeight)
            button.viewWithTag(Self.underlineTag)?.frame = CGRect(x: 0, y: headerHeight - 2, width: button.bounds.width, height: 2)
            x += button.bounds.width
        }
        closeButton.frame = CGRect(x: header.bounds.width - 40, y: (headerHeight - 40) / 2, width: 40, height: 40)
        divider.frame = CGRect(x: 0, y: header.frame.maxY, width: width, height: 1)
        scroll.frame = CGRect(x: 0, y: divider.frame.maxY, width: width - insets.right, height: max(bounds.height - divider.frame.maxY, 0))
        layoutList()
    }

    private func render(keepScroll: Bool) {
        let offset = keepScroll ? scroll.contentOffset : .zero
        imageEpoch += 1
        tabs.forEach { $0.button.removeFromSuperview() }
        tabs = []
        if !browse.chapters.isEmpty { addTab(texts.chapters, .chapters) }
        if !browse.upNext.isEmpty { addTab(texts.upNext, .upNext) }
        list.subviews.forEach { $0.removeFromSuperview() }
        chapterRows = []
        if tab == .chapters { fillChapters() } else { fillUpNext() }
        setNeedsLayout()
        layoutIfNeeded()
        if keepScroll {
            scroll.contentOffset = CGPoint(x: 0, y: min(offset.y, max(scroll.contentSize.height - scroll.bounds.height, 0)))
        } else if tab == .chapters, let index = currentChapter, chapterRows.indices.contains(index) {
            // Open where the playhead is.
            let top = chapterRows[index].row.frame.minY - 48 * scale
            scroll.contentOffset = CGPoint(x: 0, y: min(max(top, 0), max(scroll.contentSize.height - scroll.bounds.height, 0)))
        }
    }

    private func addTab(_ title: String, _ which: Tab) {
        let button = UIButton(type: .custom)
        let selected = which == tab
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = PlayerFont.weight(selected ? .bold : .regular, size: 15 * scale)
        button.setTitleColor(selected ? .white : BrowseSkin.secondary, for: .normal)
        button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 12, bottom: 8, right: 12)
        if selected {
            let underline = UIView()
            underline.backgroundColor = .white
            underline.isUserInteractionEnabled = false
            underline.tag = Self.underlineTag
            button.addSubview(underline)
            button.accessibilityTraits.insert(.selected)
        }
        button.accessibilityTraits.insert(.header)
        button.addAction(UIAction { [weak self] _ in
            guard let self, self.tab != which else { return }
            self.tab = which
            self.render(keepScroll: false)
        }, for: .touchUpInside)
        header.addSubview(button)
        tabs.append((which, button))
    }

    private func fillChapters() {
        for (index, chapter) in browse.chapters.enumerated() {
            let row = UIControl()
            row.layer.cornerRadius = 10 * scale
            let marker = GlyphButton(size: 18 * scale, iconSize: 14 * scale)
            marker.layers = V10Icons.play
            marker.isUserInteractionEnabled = false
            marker.isAccessibilityElement = false
            let title = UILabel()
            title.text = chapter.title
            title.textColor = .white
            title.numberOfLines = 2
            let time = UILabel()
            time.text = formatTime(chapter.start, guide: guide)
            time.font = PlayerFont.monospacedDigits(size: 13 * scale, weight: .regular)
            time.textColor = BrowseSkin.secondary
            time.tag = 1
            for part in [marker, title, time] as [UIView] { row.addSubview(part) }
            row.isAccessibilityElement = true
            row.accessibilityLabel = "\(chapter.title), \(time.text ?? "")"
            row.accessibilityTraits = .button
            row.addAction(UIAction { [weak self] _ in self?.onChapter?(chapter) }, for: .touchUpInside)
            list.addSubview(row)
            let entry = (row: row, title: title, marker: marker)
            style(entry, now: index == currentChapter)
            chapterRows.append(entry)
        }
    }

    private func style(_ row: (row: UIControl, title: UILabel, marker: GlyphButton), now: Bool) {
        row.row.backgroundColor = now ? BrowseSkin.selectedRow : .clear
        row.title.font = PlayerFont.weight(now ? .bold : .regular, size: 15 * scale)
        row.marker.isHidden = !now
        if now { row.row.accessibilityTraits.insert(.selected) } else { row.row.accessibilityTraits.remove(.selected) }
    }

    private func fillUpNext() {
        let epoch = imageEpoch
        for (index, item) in browse.upNext.enumerated() {
            // A section's name shows once, over the first item of each run that carries it.
            if let section = item.section, section != (index > 0 ? browse.upNext[index - 1].section : nil) {
                let heading = UILabel()
                heading.attributedText = sectionText(section, size: 11 * scale, color: BrowseSkin.secondary)
                heading.accessibilityTraits = .header
                heading.tag = index == 0 ? 2 : 3
                list.addSubview(heading)
            }
            let row = UIControl()
            row.layer.cornerRadius = 10 * scale
            let picture = UIImageView()
            picture.backgroundColor = BrowseSkin.tile
            picture.contentMode = .scaleAspectFill
            picture.clipsToBounds = true
            picture.layer.cornerRadius = 8 * scale
            FrameImages.load(item.imageUrl, fallback: item.fallbackImageUrl, width: BrowseSkin.upNextPicture * scale) { [weak self, weak picture] image in
                guard let self, self.imageEpoch == epoch, let image else { return }
                picture?.image = image
            }
            let title = UILabel()
            title.text = item.title
            title.font = PlayerFont.weight(.bold, size: 14 * scale)
            title.textColor = .white
            title.numberOfLines = 2
            title.tag = 4
            row.addSubview(picture)
            row.addSubview(title)
            if let subtitle = item.subtitle, !subtitle.isEmpty {
                let words = UILabel()
                words.text = subtitle
                words.font = PlayerFont.regular(size: 12 * scale)
                words.textColor = BrowseSkin.secondary
                words.numberOfLines = 2
                words.tag = 5
                row.addSubview(words)
            }
            row.isAccessibilityElement = true
            row.accessibilityLabel = [item.title, item.subtitle].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
            if item.current {
                // What plays now is marked where it stands, as the chapter playing is, and is not a pick.
                row.backgroundColor = BrowseSkin.selectedRow
                row.accessibilityTraits = [.selected, .notEnabled]
            } else {
                row.accessibilityTraits = .button
                row.addAction(UIAction { [weak self] _ in self?.onUpNext?(item.id) }, for: .touchUpInside)
                row.addAction(UIAction { [weak row] _ in row?.backgroundColor = BrowseSkin.selectedRow }, for: .touchDown)
                row.addAction(UIAction { [weak row] _ in row?.backgroundColor = .clear }, for: [.touchUpInside, .touchUpOutside, .touchCancel])
            }
            list.addSubview(row)
        }
    }

    /// Stacks the list's rows down the width of the scroll view, each as tall as its words need.
    private func layoutList() {
        let width = scroll.bounds.width - 16
        var y: CGFloat = 8
        for view in list.subviews {
            switch view {
            case let heading as UILabel:
                let top: CGFloat = heading.tag == 2 ? 4 : 14
                let height = heading.sizeThatFits(CGSize(width: width - 16, height: .greatestFiniteMagnitude)).height
                heading.frame = CGRect(x: 8, y: y + top * scale, width: width - 16, height: height)
                y = heading.frame.maxY + 6 * scale
            case let row as UIControl where row.subviews.first is GlyphButton:
                y = layoutChapterRow(row, width: width, y: y)
            case let row as UIControl:
                y = layoutUpNextRow(row, width: width, y: y)
            default:
                break
            }
        }
        list.frame = CGRect(x: 8, y: 0, width: width, height: y + 16)
        scroll.contentSize = CGSize(width: scroll.bounds.width, height: list.frame.height)
    }

    private func layoutChapterRow(_ row: UIControl, width: CGFloat, y: CGFloat) -> CGFloat {
        guard let marker = row.subviews.first, let title = row.subviews.dropFirst().first as? UILabel,
              let time = row.subviews.first(where: { $0.tag == 1 }) as? UILabel else { return y }
        time.sizeToFit()
        let markerSide = 18 * scale
        let titleX = 8 * scale + markerSide + 6 * scale
        let titleWidth = width - titleX - 12 * scale - time.bounds.width - 12 * scale
        let titleHeight = title.sizeThatFits(CGSize(width: titleWidth, height: .greatestFiniteMagnitude)).height
        let height = max(48 * scale, titleHeight + 20 * scale)
        row.frame = CGRect(x: 0, y: y, width: width, height: height)
        marker.frame = CGRect(x: 8 * scale, y: (height - markerSide) / 2, width: markerSide, height: markerSide)
        title.frame = CGRect(x: titleX, y: (height - titleHeight) / 2, width: titleWidth, height: titleHeight)
        time.frame = CGRect(x: width - 12 * scale - time.bounds.width, y: (height - time.bounds.height) / 2, width: time.bounds.width, height: time.bounds.height)
        return row.frame.maxY + 2 * scale
    }

    private func layoutUpNextRow(_ row: UIControl, width: CGFloat, y: CGFloat) -> CGFloat {
        guard let picture = row.subviews.first as? UIImageView else { return y }
        let pad = 8 * scale
        let pictureWidth = BrowseSkin.upNextPicture * scale
        let pictureHeight = pictureWidth * 9 / 16
        let wordsX = pad + pictureWidth + 12 * scale
        let wordsWidth = max(width - wordsX - pad, 0)
        let title = row.subviews.first { $0.tag == 4 } as? UILabel
        let subtitle = row.subviews.first { $0.tag == 5 } as? UILabel
        let titleHeight = title?.sizeThatFits(CGSize(width: wordsWidth, height: .greatestFiniteMagnitude)).height ?? 0
        let subtitleHeight = subtitle?.sizeThatFits(CGSize(width: wordsWidth, height: .greatestFiniteMagnitude)).height ?? 0
        let wordsHeight = titleHeight + subtitleHeight
        let height = max(pictureHeight, wordsHeight) + 2 * pad
        row.frame = CGRect(x: 0, y: y, width: width, height: height)
        picture.frame = CGRect(x: pad, y: (height - pictureHeight) / 2, width: pictureWidth, height: pictureHeight)
        let top = (height - wordsHeight) / 2
        title?.frame = CGRect(x: wordsX, y: top, width: wordsWidth, height: titleHeight)
        subtitle?.frame = CGRect(x: wordsX, y: top + titleHeight, width: wordsWidth, height: subtitleHeight)
        return row.frame.maxY + 2 * scale
    }
}

/// The strip of next videos, offered near the end of full-screen: a heading with a close button, and a row of cards
/// the size and shape of the scrub frames, right-aligned while they fit and scrolling when they do not.
final class NextUpStrip: UIView {
    var onPick: ((String) -> Void)?
    var onClose: (() -> Void)?

    private let heading = UILabel()
    private let closeButton = GlyphButton(size: 36, iconSize: 20)
    private let scroll = UIScrollView()
    private var cards: [UIControl] = []
    private var cardHeight: CGFloat = 0
    private let headHeight: CGFloat = 36
    /// Pictures of a strip that is gone are not drawn.
    private var live = true

    init(items: [BrowseItem], texts: FullscreenTexts, cardHeight: CGFloat, scale: CGFloat) {
        self.cardHeight = cardHeight
        super.init(frame: .zero)
        heading.text = texts.upNext
        heading.font = PlayerFont.weight(.bold, size: 16 * scale)
        heading.textColor = .white
        heading.layer.shadowColor = UIColor.black.cgColor
        heading.layer.shadowOpacity = 0.5
        heading.layer.shadowRadius = 2
        heading.layer.shadowOffset = CGSize(width: 0, height: 1)
        heading.accessibilityTraits = .header
        addSubview(heading)
        closeButton.layers = BrowseIcons.close
        closeButton.accessibilityLabel = texts.dismiss
        closeButton.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        addSubview(closeButton)
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = false
        addSubview(scroll)
        let cardWidth = cardHeight * 16 / 9
        for item in items {
            let card = UIControl()
            card.backgroundColor = BrowseSkin.tile
            card.layer.cornerRadius = 6 * scale
            card.layer.borderWidth = 1
            card.layer.borderColor = BrowseSkin.tileEdge.cgColor
            card.clipsToBounds = true
            let picture = UIImageView()
            picture.contentMode = .scaleAspectFill
            picture.clipsToBounds = true
            picture.isUserInteractionEnabled = false
            FrameImages.load(item.imageUrl, fallback: item.fallbackImageUrl, width: cardWidth) { [weak self, weak picture] image in
                guard self?.live == true, let image else { return }
                picture?.image = image
            }
            card.addSubview(picture)
            // The name over the foot of the frame, as the scrub strip puts its timecode.
            let caption = CaptionView(section: item.section, title: item.title, scale: scale)
            card.addSubview(caption)
            card.isAccessibilityElement = true
            card.accessibilityLabel = [item.section, item.title].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
            card.accessibilityTraits = .button
            card.addAction(UIAction { [weak self] _ in self?.onPick?(item.id) }, for: .touchUpInside)
            scroll.addSubview(card)
            cards.append(card)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The heading's row and the cards'.
    var preferredHeight: CGFloat { headHeight + cardHeight }

    func takeDown() {
        live = false
        removeFromSuperview()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        closeButton.frame = CGRect(x: bounds.width - 36, y: 0, width: 36, height: headHeight)
        heading.sizeToFit()
        heading.frame = CGRect(
            x: closeButton.frame.minX - 4 - heading.bounds.width, y: (headHeight - heading.bounds.height) / 2,
            width: heading.bounds.width, height: heading.bounds.height
        )
        scroll.frame = CGRect(x: 0, y: headHeight, width: bounds.width, height: cardHeight)
        let cardWidth = cardHeight * 16 / 9
        let gap: CGFloat = 8
        let content = CGFloat(cards.count) * (cardWidth + gap)
        // Right-aligned while they all fit.
        var x = max(scroll.bounds.width - content, 0) + gap
        for card in cards {
            card.frame = CGRect(x: x, y: 0, width: cardWidth, height: cardHeight)
            card.subviews.forEach { $0.frame = card.bounds }
            x += cardWidth + gap
        }
        scroll.contentSize = CGSize(width: max(content + gap, scroll.bounds.width), height: cardHeight)
    }
}

/// A card's section and title over a fade at its foot.
private final class CaptionView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    private let section = UILabel()
    private let title = UILabel()
    private let scale: CGFloat

    init(section text: String?, title name: String, scale: CGFloat) {
        self.scale = scale
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        let gradient = layer as! CAGradientLayer
        gradient.colors = [UIColor.clear.cgColor, UIColor(white: 0, alpha: 0.85).cgColor]
        if let text, !text.isEmpty {
            section.attributedText = sectionText(text, size: 10 * scale, color: UIColor(white: 1, alpha: 0.75))
            addSubview(section)
        }
        title.text = name
        title.font = PlayerFont.weight(.medium, size: 13 * scale)
        title.textColor = .white
        title.numberOfLines = 2
        addSubview(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let pad = 8 * scale
        let width = bounds.width - 2 * pad
        let titleHeight = title.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        title.frame = CGRect(x: pad, y: bounds.height - 6 * scale - titleHeight, width: width, height: titleHeight)
        let sectionHeight = section.superview == nil ? 0 : section.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        section.frame = CGRect(x: pad, y: title.frame.minY - sectionHeight, width: width, height: sectionHeight)
        // The fade starts a little above the words, so they always stand on dark.
        let top = max(section.superview == nil ? title.frame.minY : section.frame.minY, 0) - 16 * scale
        let gradient = layer as! CAGradientLayer
        gradient.startPoint = CGPoint(x: 0.5, y: max(top, 0) / max(bounds.height, 1))
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
    }
}
#endif
