/// The bridge's URI scheme (`luminary://asset | key`), answered from memory. The
/// `AVAssetResourceLoaderDelegate` in the plugin asks this for every `luminary://` request;
/// `https` is AVPlayer's to fetch, and never reaches it.
public final class UriRouter: Sendable {
    public enum Route: Sendable {
        case served(bytes: [UInt8], contentType: String)
        /// `not-found` or `key-required`.
        case failed(code: String)
    }

    private let assets: AssetStore
    private let key: KeyHolder

    public init(assets: AssetStore, key: KeyHolder) {
        self.assets = assets
        self.key = key
    }

    /// What the bridge answers from memory; anything else is not the bridge's to answer.
    public func route(_ uri: String) -> Route {
        if uri == keyUri {
            guard let bytes = key.copy() else { return .failed(code: "key-required") }
            return .served(bytes: bytes, contentType: "application/octet-stream")
        }
        if uri.hasPrefix(assetUriPrefix), let asset = assets.get(uri) {
            return .served(bytes: asset.bytes, contentType: asset.contentType)
        }
        return .failed(code: "not-found")
    }
}
