#if canImport(UIKit)
import AVFoundation
import ObjectiveC
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

/// The words of the subtitles that are on, as they change, for a view to draw where it wants them: under the
/// picture in the page, over the picture's foot in full screen, and not at all over a small picture in front.
/// The player draws none of its own meanwhile, except in picture in picture, which only the player can draw in.
///
/// One per player, shared by every view that shows it, and following the player from item to item.
final class LegibleText: NSObject, AVPlayerItemLegibleOutputPushDelegate {
    private static var key: UInt8 = 0

    /// The player's own, made on first use.
    static func of(_ player: AVPlayer) -> LegibleText {
        if let text = objc_getAssociatedObject(player, &key) as? LegibleText { return text }
        let text = LegibleText(player: player)
        objc_setAssociatedObject(player, &key, text, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return text
    }

    /// The lines on screen now; empty between cues and with the subtitles off.
    private(set) var text = ""
    private var observers: [UUID: (String) -> Void] = [:]
    private var output: AVPlayerItemLegibleOutput?
    private weak var item: AVPlayerItem?
    private var itemObservation: NSKeyValueObservation?
    private var pictureInPicture = false

    private init(player: AVPlayer) {
        super.init()
        itemObservation = player.observe(\.currentItem, options: [.initial, .new]) { [weak self] player, _ in
            DispatchQueue.main.async { self?.attach(to: player.currentItem) }
        }
    }

    /// `onChange` is called with the lines each time they change, and once now. Keep the token to stop.
    func observe(_ onChange: @escaping (String) -> Void) -> UUID {
        let token = UUID()
        observers[token] = onChange
        onChange(text)
        return token
    }

    func stopObserving(_ token: UUID?) {
        guard let token else { return }
        observers[token] = nil
    }

    /// Picture in picture shows the player's own drawing only, so the player draws the words while it is up.
    func setPictureInPicture(_ active: Bool) {
        pictureInPicture = active
        output?.suppressesPlayerRendering = !active
        publish(text)
    }

    private func attach(to next: AVPlayerItem?) {
        guard next !== item else { return }
        if let output, let item { item.remove(output) }
        item = next
        output = nil
        publish("")
        guard let next else { return }
        let output = AVPlayerItemLegibleOutput()
        output.suppressesPlayerRendering = !pictureInPicture
        output.setDelegate(self, queue: .main)
        next.add(output)
        self.output = output
    }

    func legibleOutput(
        _ output: AVPlayerItemLegibleOutput,
        didOutputAttributedStrings strings: [NSAttributedString],
        nativeSampleBuffers nativeSamples: [Any],
        forItemTime itemTime: CMTime
    ) {
        guard output === self.output else { return }
        let lines = strings.map { $0.string.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        publish(lines.joined(separator: "\n"))
    }

    private func publish(_ next: String) {
        text = next
        let shown = pictureInPicture ? "" : next
        for observer in observers.values { observer(shown) }
    }
}

/// Subtitle lines as the player's own surfaces draw them: white, centred, with a shadow to read on any picture.
final class SubtitleLabel: UILabel {
    override init(frame: CGRect) {
        super.init(frame: frame)
        numberOfLines = 0
        textAlignment = .center
        textColor = .white
        lineBreakMode = .byWordWrapping
        isUserInteractionEnabled = false
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.9
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)
        accessibilityTraits = .updatesFrequently
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
#endif
