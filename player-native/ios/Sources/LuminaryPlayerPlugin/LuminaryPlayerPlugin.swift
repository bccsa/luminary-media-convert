import Capacitor
import Foundation
import UIKit
#if canImport(LuminaryPlayerCore)
import LuminaryPlayerCore
#endif
#if canImport(LuminaryPlayerUI)
import LuminaryPlayerUI
#endif

/// The bridge's native end: decode and validate, then the main thread, then ``PlayerRegistry``.
/// Rejects only with a ``BridgeErrorCode``. Never logs a call: `load` carries the key.
///
/// The same shim as Android's: every method hands `call.options` to `PlayerRegistry.call`, the
/// one decode path the conformance harness also runs.
@objc(LuminaryPlayerPlugin)
public class LuminaryPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LuminaryPlayerPlugin"
    public let jsName = "LuminaryPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        "getInfo", "reset", "create", "load", "putAssets", "putLive", "releaseAssets", "reattach",
        "play", "pause", "seek", "setRate", "setVariant", "setAudioTrack", "warmChunks",
        "enterFullscreen", "exitFullscreen", "resumed", "destroy",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    /// AVPlayer cannot pin a rendition; picture in picture arrives with the phase 2 presenter.
    private static let capabilities = BridgeCapabilities()

    private var registry: PlayerRegistry?

    override public func load() {
        let presenterHost: () -> UIViewController? = { [weak self] in self?.bridge?.viewController }
        registry = PlayerRegistry(
            capabilities: Self.capabilities,
            clock: MainQueueClock(),
            engineFactory: { router, clock, options in
                AVPlayerEngine(
                    router: router,
                    clock: clock,
                    options: options,
                    presenter: PlayerViewControllerPresenter(host: presenterHost)
                )
            },
            emit: { [weak self] name, payload in
                self?.notifyListeners(name, data: JSON.object(payload).anyValue as? [String: Any])
            }
        )
    }

    @objc func getInfo(_ call: CAPPluginCall) { dispatch("getInfo", call) }
    @objc func reset(_ call: CAPPluginCall) { dispatch("reset", call) }
    @objc func create(_ call: CAPPluginCall) { dispatch("create", call) }
    @objc public func load(_ call: CAPPluginCall) { dispatch("load", call) }
    @objc func putAssets(_ call: CAPPluginCall) { dispatch("putAssets", call) }
    @objc func putLive(_ call: CAPPluginCall) { dispatch("putLive", call) }
    @objc func releaseAssets(_ call: CAPPluginCall) { dispatch("releaseAssets", call) }
    @objc func reattach(_ call: CAPPluginCall) { dispatch("reattach", call) }
    @objc func play(_ call: CAPPluginCall) { dispatch("play", call) }
    @objc func pause(_ call: CAPPluginCall) { dispatch("pause", call) }
    @objc func seek(_ call: CAPPluginCall) { dispatch("seek", call) }
    @objc func setRate(_ call: CAPPluginCall) { dispatch("setRate", call) }
    @objc func setVariant(_ call: CAPPluginCall) { dispatch("setVariant", call) }
    @objc func setAudioTrack(_ call: CAPPluginCall) { dispatch("setAudioTrack", call) }
    @objc func warmChunks(_ call: CAPPluginCall) { dispatch("warmChunks", call) }
    @objc func enterFullscreen(_ call: CAPPluginCall) { dispatch("enterFullscreen", call) }
    @objc func exitFullscreen(_ call: CAPPluginCall) { dispatch("exitFullscreen", call) }
    @objc func resumed(_ call: CAPPluginCall) { dispatch("resumed", call) }
    @objc func destroy(_ call: CAPPluginCall) { dispatch("destroy", call) }

    /// Capacitor delivers calls in order on one queue; the main queue keeps that order.
    private func dispatch(_ method: String, _ call: CAPPluginCall) {
        let args = JSON(any: call.options as [AnyHashable: Any]?).objectValue ?? [:]
        DispatchQueue.main.async { [weak self] in
            guard let registry = self?.registry else {
                call.reject("The plugin has not loaded", BridgeErrorCode.engine.rawValue)
                return
            }
            do {
                let result = try registry.call(method, args)
                call.resolve(result.anyValue as? [String: Any] ?? [:])
            } catch let rejection as BridgeRejection {
                call.reject(rejection.message, rejection.code.rawValue)
            } catch {
                call.reject("\(error)", BridgeErrorCode.engine.rawValue)
            }
        }
    }
}
