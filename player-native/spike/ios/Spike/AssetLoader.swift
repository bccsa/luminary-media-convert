import AVFoundation
import UniformTypeIdentifiers

/// Answers `luminary://asset/…` and `luminary://key` from memory: the part of
/// the bridge's `UriRouter` that step 0 has to prove works with our streams.
///
/// Every request is logged with what was answered, so the spike's output shows
/// which content types AVFoundation accepts and what it asks for.
final class AssetLoader: NSObject, AVAssetResourceLoaderDelegate {
    /// How `contentInformationRequest.contentType` is filled — the question.
    enum TypeMode: String, CaseIterable {
        /// A UTI derived from the MIME type the bridge sends.
        case uti
        /// The MIME type exactly as the bridge sends it.
        case mime
        /// Left unset.
        case none
    }

    static let keyUri = "luminary://key"

    let queue = DispatchQueue(label: "org.bccsa.luminary.spike.asset-loader")
    var mode: TypeMode = .uti
    var log: (String) -> Void = { print($0) }

    /// Touched only on `queue`.
    private var assets: [String: (data: Data, contentType: String)] = [:]
    private var key: Data?

    func put(_ assets: [Payload.Asset]) {
        queue.sync {
            for asset in assets {
                self.assets[asset.uri] = (Data(asset.text.utf8), asset.contentType)
            }
        }
    }

    func setKey(hex: String?) {
        let bytes = hex.flatMap(Data.init(hex:))
        queue.sync { key = bytes }
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard let uri = request.request.url?.absoluteString else { return false }

        if uri == Self.keyUri {
            guard let key else {
                log("loader  \(uri) -> no key")
                request.finishLoading(with: NSError(domain: "spike", code: 1))
                return true
            }
            answer(request, uri: uri, data: key, contentType: "application/octet-stream")
            return true
        }
        guard let asset = assets[uri] else {
            log("loader  \(uri) -> not found")
            request.finishLoading(with: NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return true
        }
        answer(request, uri: uri, data: asset.data, contentType: asset.contentType)
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel request: AVAssetResourceLoadingRequest
    ) {
        log("loader  \(request.request.url?.absoluteString ?? "?") cancelled")
    }

    private func answer(
        _ request: AVAssetResourceLoadingRequest,
        uri: String,
        data: Data,
        contentType: String
    ) {
        var typeSet = "unset"
        if let info = request.contentInformationRequest {
            switch mode {
            case .uti:
                let uti = UTType(mimeType: contentType)?.identifier ?? "public.data"
                info.contentType = uti
                typeSet = uti
            case .mime:
                info.contentType = contentType
                typeSet = contentType
            case .none:
                break
            }
            info.contentLength = Int64(data.count)
            info.isByteRangeAccessSupported = false
        }
        var range = "none"
        if let dataRequest = request.dataRequest {
            let start = Int(dataRequest.requestedOffset)
            let end = dataRequest.requestsAllDataToEndOfResource
                ? data.count
                : min(data.count, start + dataRequest.requestedLength)
            dataRequest.respond(with: data.subdata(in: start..<max(start, end)))
            range = "\(start)..<\(end)"
        }
        request.finishLoading()
        log("loader  \(uri) -> \(data.count) B, type=\(typeSet), info=\(request.contentInformationRequest != nil), range=\(range)")
    }
}

extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
