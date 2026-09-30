import AVFoundation
import UniformTypeIdentifiers

/// The bridge's URI scheme (`luminary://asset | key`), answered from memory, and the
/// `AVAssetResourceLoaderDelegate` AVPlayer asks for every `luminary://` request. `https` is
/// AVPlayer's to fetch and never reaches it.
///
/// It answers on ``queue``, its own serial queue, reading an ``AssetStore`` and a ``KeyHolder``
/// the main thread writes, both of which lock.
public final class UriRouter: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    public enum Route: Sendable {
        case served(bytes: [UInt8], contentType: String)
        /// `not-found` or `key-required`.
        case failed(code: String)
    }

    /// The domain of the errors a failed route finishes a loading request with.
    public static let errorDomain = "org.bccsa.luminary.player.UriRouter"

    /// The codes in ``errorDomain``, one per ``Route/failed(code:)``.
    public enum ErrorCode: Int, Sendable {
        case notFound = 1
        case keyRequired = 2
    }

    /// The queue to hand AVFoundation with this delegate.
    public let queue = DispatchQueue(label: "org.bccsa.luminary.player.UriRouter")

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

    // MARK: AVAssetResourceLoaderDelegate

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        answer(AVLoadingRequest(loadingRequest))
    }

    /// Answers one request, or returns false for a URI outside the scheme.
    ///
    /// - A request may ask for data alone, with no content-type question (AVFoundation asks for
    ///   an audio playlist again that way), and is answered the same.
    /// - The content type is reported as a UTI, mapped from the MIME type JavaScript sent.
    /// - The requested range is honoured, though AVFoundation asks for the whole resource.
    /// - A missing asset or key finishes with an error in ``errorDomain``.
    func answer(_ request: LoadingRequest) -> Bool {
        guard let uri = request.uri, uri.hasPrefix("luminary://") else { return false }

        switch route(uri) {
        case .failed(let code):
            let errorCode: ErrorCode = code == "key-required" ? .keyRequired : .notFound
            request.finish(with: NSError(
                domain: Self.errorDomain,
                code: errorCode.rawValue,
                userInfo: [NSLocalizedDescriptionKey: "\(code): \(uri)"]
            ))
        case .served(let bytes, let contentType):
            if request.wantsContentInformation {
                request.setContentInformation(
                    contentType: Self.uti(forMimeType: contentType),
                    contentLength: Int64(bytes.count)
                )
            }
            if let range = request.dataRange {
                let start = min(Int(clamping: range.offset), bytes.count)
                let end = range.length.map { min(bytes.count, start + $0) } ?? bytes.count
                request.respond(with: Data(bytes[start..<max(start, end)]))
            }
            request.finish()
        }
        return true
    }

    /// `application/vnd.apple.mpegurl` → `public.m3u-playlist`, and so on; `public.data` for a
    /// MIME type the system does not know, which `UTType` would otherwise answer with a made-up
    /// dynamic identifier.
    static func uti(forMimeType mimeType: String) -> String {
        guard let type = UTType(mimeType: mimeType), !type.isDynamic else { return UTType.data.identifier }
        return type.identifier
    }
}

/// What answering a request needs from `AVAssetResourceLoadingRequest`, so the rules can be
/// tested without AVFoundation issuing a request.
protocol LoadingRequest {
    var uri: String? { get }
    /// Whether AVFoundation asked for the content type and length.
    var wantsContentInformation: Bool { get }
    /// The bytes asked for: nil when no data was requested, and a nil length for "to the end".
    var dataRange: (offset: Int64, length: Int?)? { get }
    func setContentInformation(contentType: String, contentLength: Int64)
    func respond(with data: Data)
    func finish()
    func finish(with error: Error)
}

private struct AVLoadingRequest: LoadingRequest {
    let request: AVAssetResourceLoadingRequest

    init(_ request: AVAssetResourceLoadingRequest) {
        self.request = request
    }

    var uri: String? { request.request.url?.absoluteString }

    var wantsContentInformation: Bool { request.contentInformationRequest != nil }

    var dataRange: (offset: Int64, length: Int?)? {
        guard let data = request.dataRequest else { return nil }
        return (data.requestedOffset, data.requestsAllDataToEndOfResource ? nil : data.requestedLength)
    }

    func setContentInformation(contentType: String, contentLength: Int64) {
        guard let info = request.contentInformationRequest else { return }
        info.contentType = contentType
        info.contentLength = contentLength
        info.isByteRangeAccessSupported = false
    }

    func respond(with data: Data) {
        request.dataRequest?.respond(with: data)
    }

    func finish() {
        request.finishLoading()
    }

    func finish(with error: Error) {
        request.finishLoading(with: error)
    }
}
