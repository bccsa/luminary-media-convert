import CommonCrypto
import Foundation

/// Why a read of a live playlist failed, with the bridge's error codes.
public enum LiveFailure: Error, Equatable, Sendable {
    /// A non-2xx answer carrying its status, or a transport failure carrying its error.
    case fetchFailed(status: Int?, underlying: NSError? = nil)
    /// LMCENC with no key, or an AES-128 key with no key URI to point it at.
    case keyRequired
    /// Decryption failed, or decrypted to something that is not a playlist: the wrong key.
    case decryptFailed
    /// Neither LMCENC nor a playlist.
    case invalidContent

    public var code: String {
        switch self {
        case .fetchFailed: return "fetch-failed"
        case .keyRequired: return "key-required"
        case .decryptFailed: return "decrypt-failed"
        case .invalidContent: return "invalid-content"
        }
    }
}

/// One read of `url`: completes with the body or a ``LiveFailure``, and returns its cancel.
public typealias LiveFetch = @Sendable (
    _ url: URL,
    _ completion: @escaping @Sendable (Result<Data, LiveFailure>) -> Void
) -> @Sendable () -> Void

/// `luminary://live/<n>`, one read per engine request, ported from `resolveLivePlaylist`
/// (`player-core/src/policy/live.ts`): fetch, decrypt when LMCENC, refuse an AES-128 key with
/// no key URI, rewrite. No timer: AVPlayer's own refresh drives it, so it keeps a live stream
/// fresh while JavaScript is frozen.
public enum LiveResolver {
    /// Reads `spec.url` afresh, bypassing every cache: a cached read would freeze the window.
    public static let urlSessionFetch: LiveFetch = { url, completion in
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(.fetchFailed(status: nil, underlying: error as NSError)))
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                completion(.failure(.fetchFailed(status: http.statusCode)))
            } else {
                completion(.success(data ?? Data()))
            }
        }
        task.resume()
        return { task.cancel() }
    }

    /// Fetches and resolves `spec`; the completion runs on the fetch's queue.
    public static func resolve(
        _ spec: BridgeLiveSpec,
        fetch: LiveFetch,
        completion: @escaping @Sendable (Result<String, LiveFailure>) -> Void
    ) -> @Sendable () -> Void {
        guard let url = URL(string: spec.url) else {
            completion(.failure(.fetchFailed(status: nil)))
            return {}
        }
        return fetch(url) { result in
            completion(result.flatMap { bytes in Result { try decode(bytes, spec) }.mapError { $0 as! LiveFailure } })
        }
    }

    /// The steps after the fetch, in `resolveLivePlaylist`'s order.
    static func decode(_ bytes: Data, _ spec: BridgeLiveSpec) throws -> String {
        let text: String
        if Lmcenc.isEncrypted(bytes) {
            guard let keyHex = spec.keyHex else { throw LiveFailure.keyRequired }
            guard let plain = Lmcenc.decrypt(bytes, keyHex: keyHex), isPlaylist(plain) else {
                throw LiveFailure.decryptFailed
            }
            text = utf8(plain)
        } else {
            guard isPlaylist(bytes) else { throw LiveFailure.invalidContent }
            text = utf8(bytes)
        }
        if spec.keyUri == nil, hasAes128Key(text) { throw LiveFailure.keyRequired }
        return rewriteMediaPlaylist(text, playlistUrl: spec.baseUrl, keyUri: spec.keyUri)
    }

    private static let bom: [UInt8] = [0xEF, 0xBB, 0xBF]

    /// Starts with `#EXTM3U`, after an optional byte-order mark.
    static func isPlaylist(_ bytes: Data) -> Bool {
        let body = bytes.starts(with: bom) ? bytes.dropFirst(bom.count) : bytes[...]
        return body.starts(with: Array("#EXTM3U".utf8))
    }

    /// UTF-8 with a leading byte-order mark dropped, as `TextDecoder` does.
    private static func utf8(_ bytes: Data) -> String {
        let body = bytes.starts(with: bom) ? bytes.dropFirst(bom.count) : bytes[...]
        return String(decoding: body, as: UTF8.self)
    }
}

/// LMCENC (`docs/encrypted-sidecar-format.md`): `LMCENC01`, a 16-byte IV, then AES-128-CBC
/// ciphertext with PKCS#7 padding.
enum Lmcenc {
    static let magic = Array("LMCENC01".utf8)
    static let ivLength = 16

    static func isEncrypted(_ bytes: Data) -> Bool {
        bytes.count >= magic.count + ivLength && bytes.starts(with: magic)
    }

    /// The plaintext, or nil when the key is malformed or decryption fails.
    static func decrypt(_ bytes: Data, keyHex: String) -> Data? {
        guard isEncrypted(bytes), let key = hexBytes(keyHex), key.count == kCCKeySizeAES128 else { return nil }
        let iv = Array(bytes.dropFirst(magic.count).prefix(ivLength))
        let ciphertext = Array(bytes.dropFirst(magic.count + ivLength))
        var plain = [UInt8](repeating: 0, count: ciphertext.count + kCCBlockSizeAES128)
        var written = 0
        let status = CCCrypt(
            CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
            key, key.count, iv, ciphertext, ciphertext.count, &plain, plain.count, &written
        )
        guard status == kCCSuccess else { return nil }
        return Data(plain.prefix(written))
    }

    private static func hexBytes(_ hex: String) -> [UInt8]? {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        return bytes
    }
}
