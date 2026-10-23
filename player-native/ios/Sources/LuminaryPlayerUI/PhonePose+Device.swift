#if canImport(UIKit)
import UIKit
// One module in the pod, separate modules in the Swift package.
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif

extension PhonePose {
    /// The device's reading as a pose; none for flat, upside down and unknown.
    init?(_ orientation: UIDeviceOrientation) {
        switch orientation {
        case .portrait: self = .upright
        case .landscapeLeft, .landscapeRight: self = .sideways
        default: return nil
        }
    }

    /// How the phone is held at the moment, as far as the device can tell.
    static var current: PhonePose? { PhonePose(UIDevice.current.orientation) }
}
#endif
