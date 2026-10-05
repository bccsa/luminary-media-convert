import AVFoundation
import UniformTypeIdentifiers

/// The bridge's URI scheme (`luminary://asset | key | live`), and the
/// `AVAssetResourceLoaderDelegate` AVPlayer asks for every `luminary://` request. `https` is
/// AVPlayer's to fetch and never reaches it.
///
/// It answers on ``queue``, its own serial queue, reading an ``AssetStore`` and a ``KeyHolder``
/// the main thread writes, both of which lock. Assets and the key come from memory; a live
/// playlist is read afresh by ``LiveResolver`` on every request.
public final class UriRouter: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    public enum Route: Sendable {
        case served(bytes: [UInt8], contentType: String)
        /// `not-found` or `key-required`.
        case failed(code: String)
        /// Read and rewritten per request.
        case live(BridgeLiveSpec)
        /// A live address that is not registered, or no longer: left open until AVPlayer
        /// cancels it.
        case unanswered
    }

    /// The domain of the errors a failed route finishes a loading request with.
    public static let errorDomain = "org.bccsa.luminary.player.UriRouter"

    /// The codes in ``errorDomain``, one per ``Route/failed(code:)``.
    public enum ErrorCode: Int, Sendable {
        case notFound = 1
        case keyRequired = 2
        case fetchFailed = 3
        case decryptFailed = 4
        case invalidContent = 5
    }

    /// The upstream HTTP status of a failed live read, in a failure's `userInfo`.
    public static let statusKey = "status"

    /// What a live playlist is answered as.
    static let playlistContentType = "application/vnd.apple.mpegurl"

    /// The queue to hand AVFoundation with this delegate.
    public let queue = DispatchQueue(label: "org.bccsa.luminary.player.UriRouter")

    private let assets: AssetStore
    private let key: KeyHolder
    private let fetch: LiveFetch
    /// The live reads in flight, by request, so a cancelled request cancels its read. On ``queue``.
    private var reads: [ObjectIdentifier: @Sendable () -> Void] = [:]

    /// `fetch` reads a live playlist; `URLSession` when nil.
    public init(assets: AssetStore, key: KeyHolder, fetch: LiveFetch? = nil) {
        self.assets = assets
        self.key = key
        self.fetch = fetch ?? LiveResolver.urlSessionFetch
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
        if uri.hasPrefix(liveUriPrefix) {
            return assets.live(uri).map(Route.live) ?? .unanswered
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

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        cancel(AVLoadingRequest(loadingRequest))
    }

    /// Answers one request, or returns false for a URI outside the scheme.
    ///
    /// - A request may ask for data alone, with no content-type question (AVFoundation asks for
    ///   an audio playlist again that way), and is answered the same.
    /// - The content type is reported as a UTI, mapped from the MIME type JavaScript sent.
    /// - The requested range is honoured, though AVFoundation asks for the whole resource.
    /// - A missing asset or key finishes with an error in ``errorDomain``.
    /// - A live playlist is answered once its read completes, on ``queue``; a failed read
    ///   finishes with its code, and the upstream status under ``statusKey``.
    func answer(_ request: LoadingRequest) -> Bool {
        guard let uri = request.uri, uri.hasPrefix("luminary://") else { return false }

        switch route(uri) {
        case .failed(let code):
            let errorCode: ErrorCode = code == "key-required" ? .keyRequired : .notFound
            request.finish(with: failure(errorCode, "\(code): \(uri)"))
        case .served(let bytes, let contentType):
            serve(request, bytes: bytes, contentType: contentType)
        case .live(let spec):
            read(spec, for: request)
        case .unanswered:
            break
        }
        return true
    }

    /// Called on ``queue``, as every delegate call is.
    func cancel(_ request: LoadingRequest) {
        reads.removeValue(forKey: request.id)?()
    }

    private func read(_ spec: BridgeLiveSpec, for request: LoadingRequest) {
        let id = request.id
        let cancel = LiveResolver.resolve(spec, fetch: fetch) { [weak self] result in
            guard let self else { return }
            self.queue.async {
                // Cancelled while it was being read.
                guard self.reads.removeValue(forKey: id) != nil else { return }
                switch result {
                case .success(let text):
                    self.serve(request, bytes: Array(text.utf8), contentType: Self.playlistContentType)
                case .failure(let failure):
                    request.finish(with: self.failure(failure, spec.url))
                }
            }
        }
        reads[id] = cancel
    }

    private func failure(_ failure: LiveFailure, _ url: String) -> NSError {
        let code: ErrorCode
        var userInfo: [String: Any] = [NSLocalizedDescriptionKey: "\(failure.code): \(url)"]
        switch failure {
        case .fetchFailed(let status):
            code = .fetchFailed
            if let status { userInfo[Self.statusKey] = status }
        case .keyRequired: code = .keyRequired
        case .decryptFailed: code = .decryptFailed
        case .invalidContent: code = .invalidContent
        }
        return NSError(domain: Self.errorDomain, code: code.rawValue, userInfo: userInfo)
    }

    private func failure(_ code: ErrorCode, _ message: String) -> NSError {
        NSError(domain: Self.errorDomain, code: code.rawValue, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func serve(_ request: LoadingRequest, bytes: [UInt8], contentType: String) {
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
    /// The same for every view of one request, so a cancel finds the read it started.
    var id: ObjectIdentifier { get }
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

    var id: ObjectIdentifier { ObjectIdentifier(request) }

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
