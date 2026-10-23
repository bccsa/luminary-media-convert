#if canImport(UIKit)
import CoreText
import UIKit

/// Inter, the web player's typeface, for the native skin. The variable font ships in the plugin's resources and is
/// registered for this process on first use; without it the system font stands in at the same size and weight.
enum PlayerFont {
    private static let fileName = "InterVariable"
    private static let weightAxis = 0x7767_6874 // 'wght'
    private static let opticalSizeAxis = 0x6F70_737A // 'opsz'

    /// The registered family, or nil when the font could not be found or registered.
    private static let family: String? = {
        guard let url = fontURL(),
              let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
              let name = descriptors.first.flatMap({ CTFontDescriptorCopyAttribute($0, kCTFontFamilyNameAttribute) as? String })
        else { return nil }
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            // Already registered (by another copy of the plugin's code, say) still leaves the family usable.
            let code = (error?.takeRetainedValue()).map { CFErrorGetCode($0) }
            guard code == CTFontManagerError.alreadyRegistered.rawValue else { return nil }
        }
        return name
    }()

    /// The pod puts resources in a bundle of their own; the Swift package in the module's bundle.
    private static func fontURL() -> URL? {
        #if SWIFT_PACKAGE
        if let url = Bundle.module.url(forResource: fileName, withExtension: "ttf") { return url }
        #endif
        let code = Bundle(for: BundleMarker.self)
        let fonts = code.url(forResource: "LuminaryPlayerFonts", withExtension: "bundle").flatMap(Bundle.init(url:))
        return fonts?.url(forResource: fileName, withExtension: "ttf") ?? code.url(forResource: fileName, withExtension: "ttf")
    }

    private final class BundleMarker {}

    static func regular(size: CGFloat) -> UIFont { weight(.regular, size: size) }

    static func weight(_ weight: UIFont.Weight, size: CGFloat) -> UIFont {
        font(size: size, weight: weight, tabular: false)
    }

    /// Tabular figures, so a running time keeps its width as its digits change.
    static func monospacedDigits(size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        font(size: size, weight: weight, tabular: true)
    }

    private static func font(size: CGFloat, weight: UIFont.Weight, tabular: Bool) -> UIFont {
        guard let family else {
            return tabular ? .monospacedDigitSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight)
        }
        // Named axes rather than the weight trait, which would only pick among the font's named instances.
        // Optical size follows the point size, as a browser's automatic optical sizing does.
        var attributes: [UIFontDescriptor.AttributeName: Any] = [
            .family: family,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [
                weightAxis: wght(weight),
                opticalSizeAxis: min(max(size, 14), 32),
            ],
        ]
        if tabular {
            attributes[.featureSettings] = [[
                UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
                UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector,
            ]]
        }
        return UIFont(descriptor: UIFontDescriptor(fontAttributes: attributes), size: size)
    }

    /// The CSS weight for a UIKit one.
    private static func wght(_ weight: UIFont.Weight) -> CGFloat {
        switch weight {
        case .ultraLight: return 100
        case .thin: return 200
        case .light: return 300
        case .medium: return 500
        case .semibold: return 600
        case .bold: return 700
        case .heavy: return 800
        case .black: return 900
        default: return 400
        }
    }
}
#endif
