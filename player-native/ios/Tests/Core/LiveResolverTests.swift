import CommonCrypto
import Foundation
import Testing
@testable import LuminaryPlayerCore

// Ported from player-core's `policy/live.spec.ts` and `pipeline/rewrite-media.spec.ts`.

private let keyHex = "000102030405060708090a0b0c0d0e0f"
private let dir = "https://live.example.com/channel/video_360"
private let liveUrl = "\(dir)/chunks.m3u8"
private let base = "https://cdn.example.com/out/session/stream_720/playlist.m3u8"

private let encryptedMedia = """
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
#EXT-X-BYTERANGE:120000@0
data_0.m4s
#EXTINF:4.000000,
#EXT-X-BYTERANGE:118000@120000
data_0.m4s
#EXT-X-ENDLIST

"""

/// The encoder's AES-128 fixture, still being written.
private let liveEncrypted = encryptedMedia.replacingOccurrences(of: "#EXT-X-ENDLIST\n", with: "")

/// A two-segment window starting at `first`, as the packager rewrites it.
private func liveWindow(_ first: Int) -> String {
    """
    #EXTM3U
    #EXT-X-VERSION:3
    #EXT-X-TARGETDURATION:4
    #EXT-X-MEDIA-SEQUENCE:\(first)
    #EXTINF:4,
    l_\(first).ts
    #EXTINF:4,
    l_\(first + 1).ts

    """
}

private func spec(baseUrl: String = liveUrl, keyUri: String? = nil, keyHex: String? = nil) -> BridgeLiveSpec {
    BridgeLiveSpec(url: liveUrl, baseUrl: baseUrl, keyUri: keyUri, keyHex: keyHex, refreshSec: 4)
}

/// An LMCENC payload, as the API's encryptor writes one.
private func lmcenc(_ plaintext: String, keyHex: String = keyHex) -> Data {
    let key = stride(from: 0, to: keyHex.count, by: 2).map { offset -> UInt8 in
        let start = keyHex.index(keyHex.startIndex, offsetBy: offset)
        return UInt8(keyHex[start..<keyHex.index(start, offsetBy: 2)], radix: 16)!
    }
    let iv = [UInt8](repeating: 7, count: 16)
    let plain = Array(plaintext.utf8)
    var out = [UInt8](repeating: 0, count: plain.count + kCCBlockSizeAES128)
    var written = 0
    let status = CCCrypt(
        CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
        key, key.count, iv, plain, plain.count, &out, out.count, &written
    )
    precondition(status == kCCSuccess)
    return Data(Array("LMCENC01".utf8) + iv + out.prefix(written))
}

/// Answers from `routes`, recording every read and every cancel.
private final class FakeUpstream: @unchecked Sendable {
    enum Answer {
        case body(Data)
        case status(Int)
        /// Never completes, until cancelled.
        case hang
    }

    private let lock = NSLock()
    var routes: [String: Answer]
    private(set) var reads: [String] = []
    private(set) var cancels = 0

    init(_ routes: [String: Answer]) {
        self.routes = routes
    }

    var fetch: LiveFetch {
        { [self] url, completion in
            lock.lock()
            reads.append(url.absoluteString)
            let answer = routes[url.absoluteString] ?? .status(404)
            lock.unlock()
            switch answer {
            case .body(let data): completion(.success(data))
            case .status(let status): completion(.failure(.fetchFailed(status: status)))
            case .hang: break
            }
            return { [self] in
                lock.lock()
                cancels += 1
                lock.unlock()
            }
        }
    }
}

/// The fake upstream answers synchronously, so the result is in by the time `resolve` returns.
private func resolve(_ spec: BridgeLiveSpec, _ upstream: FakeUpstream) -> Result<String, LiveFailure> {
    final class Box: @unchecked Sendable { var result: Result<String, LiveFailure>? }
    let box = Box()
    _ = LiveResolver.resolve(spec, fetch: upstream.fetch) { box.result = $0 }
    return box.result!
}

private func body(_ text: String) -> FakeUpstream.Answer { .body(Data(text.utf8)) }

@Suite("LiveResolver, one read per request")
struct LiveResolverTests {
    @Test("reads the playlist afresh on every call")
    func readsAfresh() throws {
        let upstream = FakeUpstream([liveUrl: body(liveWindow(100))])
        let first = try resolve(spec(), upstream).get()
        upstream.routes[liveUrl] = body(liveWindow(101))
        let second = try resolve(spec(), upstream).get()

        #expect(upstream.reads == [liveUrl, liveUrl])
        #expect(first.contains("\(dir)/l_100.ts"))
        #expect(second.contains("\(dir)/l_102.ts"))
        #expect(!second.contains("l_100.ts"))
    }

    @Test("absolutizes every URI against the base, not against where it was read")
    func absolutizesAgainstBase() throws {
        let edge = "https://edge.example.com/cache/video_360/chunks.m3u8"
        let text = try resolve(spec(baseUrl: edge), FakeUpstream([liveUrl: body(liveWindow(100))])).get()
        #expect(text.contains("https://edge.example.com/cache/video_360/l_100.ts"))
    }

    @Test("leaves the tags it does not rewrite exactly as written")
    func leavesTagsAlone() throws {
        let text = try resolve(spec(), FakeUpstream([liveUrl: body(liveWindow(100))])).get()
        #expect(Array(text.split(separator: "\n").prefix(5)) == [
            "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:100", "#EXTINF:4,",
        ])
    }

    @Test("points AES-128 keys at the key URI, leaving IV and the rest alone")
    func pointsKeys() throws {
        let upstream = FakeUpstream([liveUrl: body(liveEncrypted)])
        let text = try resolve(spec(keyUri: "fake:served/key", keyHex: keyHex), upstream).get()
        #expect(text.contains(
            #"#EXT-X-KEY:METHOD=AES-128,URI="fake:served/key",IV=0x00000000000000000000000000000001"#
        ))
        #expect(text.contains(#"#EXT-X-MAP:URI="\#(dir)/init.mp4""#))
    }

    @Test("decrypts an LMCENC-wrapped playlist with the session key")
    func decryptsLmcenc() throws {
        let upstream = FakeUpstream([liveUrl: .body(lmcenc(liveWindow(100)))])
        let text = try resolve(spec(keyUri: keyUri, keyHex: keyHex), upstream).get()
        #expect(text.contains("\(dir)/l_100.ts"))
    }

    @Test("passes a plaintext playlist through when a key is configured")
    func passesPlaintext() throws {
        let upstream = FakeUpstream([liveUrl: body(liveWindow(100))])
        let text = try resolve(spec(keyUri: keyUri, keyHex: keyHex), upstream).get()
        #expect(text.contains("\(dir)/l_100.ts"))
    }

    @Test("fails with key-required when an AES-128 key turns up and there is no key")
    func keyRequiredForAesKey() {
        let result = resolve(spec(), FakeUpstream([liveUrl: body(liveEncrypted)]))
        #expect(result == .failure(.keyRequired))
    }

    @Test("does not count METHOD=NONE as a key")
    func methodNoneIsNoKey() throws {
        let playlist = liveWindow(100).replacingOccurrences(
            of: "#EXTINF:4,\nl_100", with: "#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nl_100"
        )
        let text = try resolve(spec(), FakeUpstream([liveUrl: body(playlist)])).get()
        #expect(text.contains("#EXT-X-KEY:METHOD=NONE\n"))
    }

    @Test("fails with key-required on an LMCENC playlist when there is no key")
    func keyRequiredForLmcenc() {
        let result = resolve(spec(), FakeUpstream([liveUrl: .body(lmcenc(liveWindow(100)))]))
        #expect(result == .failure(.keyRequired))
    }

    @Test("fails with decrypt-failed under the wrong key")
    func wrongKey() {
        let upstream = FakeUpstream([liveUrl: .body(lmcenc(liveWindow(100)))])
        let result = resolve(spec(keyUri: keyUri, keyHex: "ffffffffffffffffffffffffffffffff"), upstream)
        #expect(result == .failure(.decryptFailed))
    }

    @Test("fails with invalid-content on something that is not a playlist")
    func invalidContent() {
        let result = resolve(spec(), FakeUpstream([liveUrl: body("<html>Gateway timeout</html>")]))
        #expect(result == .failure(.invalidContent))
    }

    @Test("fails with the status the upstream answered with")
    func upstreamStatus() {
        for status in [404, 503] {
            let result = resolve(spec(), FakeUpstream([liveUrl: .status(status)]))
            #expect(result == .failure(.fetchFailed(status: status)))
        }
    }
}

@Suite("rewriteMediaPlaylist, ported")
struct MediaPlaylistRewriteTests {
    private let plain = """
    #EXTM3U
    #EXT-X-VERSION:7
    #EXT-X-TARGETDURATION:4
    #EXT-X-MAP:URI="init.mp4"
    #EXTINF:4.000000,
    segment_0.m4s
    #EXT-X-ENDLIST

    """

    @Test("absolutizes segment URIs and EXT-X-MAP against the original URL")
    func absolutizes() {
        let out = rewriteMediaPlaylist(plain, playlistUrl: base, keyUri: nil)
        #expect(out.contains(#"URI="https://cdn.example.com/out/session/stream_720/init.mp4""#))
        #expect(out.contains("https://cdn.example.com/out/session/stream_720/segment_0.m4s"))
    }

    @Test("keeps query strings on the playlist URL out of the segment URLs")
    func playlistQuery() {
        let out = rewriteMediaPlaylist(plain, playlistUrl: "\(base)?token=abc", keyUri: nil)
        #expect(out.contains("https://cdn.example.com/out/session/stream_720/segment_0.m4s\n"))
    }

    @Test("carries query strings on the segment URI through")
    func segmentQuery() {
        let out = rewriteMediaPlaylist("#EXTM3U\n#EXTINF:4,\nseg.m4s?v=2\n", playlistUrl: base, keyUri: nil)
        #expect(out.contains("https://cdn.example.com/out/session/stream_720/seg.m4s?v=2"))
    }

    @Test("leaves #EXT-X-BYTERANGE untouched")
    func byteRange() {
        let out = rewriteMediaPlaylist(encryptedMedia, playlistUrl: base, keyUri: keyUri)
        #expect(out.contains("#EXT-X-BYTERANGE:120000@0"))
        #expect(out.contains("#EXT-X-BYTERANGE:118000@120000"))
    }

    @Test("overrides a real key URL: the supplied session key wins")
    func keyWins() {
        let text = encryptedMedia.replacingOccurrences(of: keyUri, with: "https://keys.example.com/session/abc.key")
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: keyUri)
        #expect(out.contains(#"URI="\#(keyUri)""#))
        #expect(!out.contains("keys.example.com"))
    }

    @Test("leaves METHOD=NONE alone")
    func methodNone() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.m4s\n"
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: "fake:key")
        #expect(out.contains("#EXT-X-KEY:METHOD=NONE\n"))
        #expect(!out.contains("fake:key"))
    }

    @Test("leaves key lines alone when no key URI is supplied")
    func noKeyUri() {
        let out = rewriteMediaPlaylist(encryptedMedia, playlistUrl: base, keyUri: nil)
        #expect(out.contains(#"URI="\#(keyUri)""#))
    }

    @Test("keeps KEYFORMAT attributes while normalizing the URI")
    func keyFormat() {
        let text = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x0f,KEYFORMAT="identity",KEYFORMATVERSIONS="1"
        #EXTINF:4,
        a.m4s

        """
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: "fake:key")
        #expect(out.contains(
            #"#EXT-X-KEY:METHOD=AES-128,URI="fake:key",IV=0x0f,KEYFORMAT="identity",KEYFORMATVERSIONS="1""#
        ))
    }

    @Test("completes a key line that names no URI")
    func keyWithoutUri() {
        let out = rewriteMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,IV=0x01\n", playlistUrl: base, keyUri: "fake:key")
        #expect(out.contains(#"#EXT-X-KEY:METHOD=AES-128,IV=0x01,URI="fake:key""#))
    }

    @Test("absolutizes URI attributes on tags it does not know, resolving dot segments")
    func unknownTagUri() {
        let text = "#EXTM3U\n#EXT-X-RENDITION-REPORT:URI=\"../audio/playlist.m3u8\",LAST-MSN=42\n#EXTINF:4,\na.m4s\n"
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: nil)
        #expect(out.contains(#"URI="https://cdn.example.com/out/session/audio/playlist.m3u8",LAST-MSN=42"#))
    }

    @Test("resolves a chunk named again after another URI, however they interleave")
    func interleavedChunks() {
        let text = "#EXTM3U\n#EXTINF:4,\n../media/a_0.m4s\n#EXTINF:4,\n../media/a_1.m4s\n#EXTINF:4,\n../media/a_0.m4s\n"
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: nil)
        let segments = out.split(separator: "\n").filter { !$0.hasPrefix("#") }
        #expect(segments == [
            "https://cdn.example.com/out/session/media/a_0.m4s",
            "https://cdn.example.com/out/session/media/a_1.m4s",
            "https://cdn.example.com/out/session/media/a_0.m4s",
        ])
    }

    @Test("resolves as the URL parser does: a trailing space goes, [ ] | stay, spaces and non-ASCII encode")
    func parserEquivalence() {
        func resolved(_ uri: String) -> String {
            rewriteMediaPlaylist("#EXTM3U\n#EXTINF:4,\n\(uri)\n", playlistUrl: base, keyUri: nil)
                .split(separator: "\n").last.map(String.init) ?? ""
        }
        let dir = "https://cdn.example.com/out/session/stream_720/"
        #expect(resolved("seg.m4s ") == dir + "seg.m4s")
        #expect(resolved("seg.m4s?a=1&b=[2]|3") == dir + "seg.m4s?a=1&b=[2]|3")
        #expect(resolved("my seg é.m4s") == dir + "my%20seg%20%C3%A9.m4s")
        #expect(resolved("/abs/seg.m4s?x=1#frag") == "https://cdn.example.com/abs/seg.m4s?x=1#frag")
        #expect(resolved("//other.example.com/a/../b/seg.m4s") == "https://other.example.com/b/seg.m4s")
        #expect(resolved("../../x/./y.m4s") == "https://cdn.example.com/out/x/y.m4s")
        #expect(resolved("https://CDN.Example.com:443/a.m4s") == "https://cdn.example.com/a.m4s")
        #expect(resolveReference("x.m4s", against: "HTTPS://CDN.Example.com:443/a/b.m3u8?t=1") == "https://cdn.example.com/a/x.m4s")
    }

    @Test("a key line naming no method, or an empty one, is no key")
    func methodlessKey() {
        #expect(!hasAes128Key("#EXTM3U\n#EXT-X-KEY:URI=\"k\"\n"))
        #expect(!hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=,URI=\"k\"\n"))
        #expect(!hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n"))
        #expect(hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n"))
    }

    @Test("an empty key URI names no key: key lines stay as written, and an AES-128 key needs one")
    func emptyKeyUri() throws {
        let key = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k/x\"\n#EXTINF:4,\na.m4s\n"
        #expect(rewriteMediaPlaylist(key, playlistUrl: base, keyUri: "").contains(#"URI="https://k/x""#))
        let spec = BridgeLiveSpec(url: base, baseUrl: base, keyUri: "", keyHex: nil, refreshSec: 4)
        #expect(throws: LiveFailure.keyRequired) { try LiveResolver.decode(Data(key.utf8), spec) }
    }

    @Test("keeps a line's carriage return, and the text around it")
    func crlf() {
        let text = "#EXTM3U\r\n#EXTINF:4.000000,\r\nsegment_0.m4s\r\n"
        let out = rewriteMediaPlaylist(text, playlistUrl: base, keyUri: nil)
        #expect(out == "#EXTM3U\r\n#EXTINF:4.000000,\r\nhttps://cdn.example.com/out/session/stream_720/segment_0.m4s\r\n")
    }
}

/// A request as AVFoundation would make it, recording how it was answered.
private final class FakeRequest: LoadingRequest, @unchecked Sendable {
    let uri: String?
    var id: ObjectIdentifier { ObjectIdentifier(self) }
    let wantsContentInformation = true
    let dataRange: (offset: Int64, length: Int?)? = (0, nil)

    var contentType: String?
    var data = Data()
    var finished = false
    var error: NSError?

    init(_ uri: String) {
        self.uri = uri
    }

    func setContentInformation(contentType: String, contentLength: Int64) { self.contentType = contentType }
    func respond(with data: Data) { self.data.append(data) }
    func finish() { finished = true }
    func finish(with error: Error) { self.error = error as NSError }
}

@Suite("UriRouter answering luminary://live")
struct UriRouterLiveTests {
    private let uri = "luminary://live/1"

    private func makeRouter(_ upstream: FakeUpstream, release: Bool = false) -> UriRouter {
        let assets = AssetStore()
        assets.putLive(1, uri, spec(keyUri: keyUri, keyHex: keyHex))
        if release {
            assets.release(1)
            assets.purgeReleased(before: 2)
        }
        return UriRouter(assets: assets, key: KeyHolder(), fetch: upstream.fetch)
    }

    /// Runs `body` on the router's queue, as AVFoundation does, then lets the answer land.
    private func onQueue(_ router: UriRouter, _ body: () -> Void) {
        router.queue.sync(execute: body)
        router.queue.sync {}
    }

    @Test("serves the playlist read for this request, as a playlist")
    func servesRead() {
        let upstream = FakeUpstream([liveUrl: body(liveWindow(100))])
        let router = makeRouter(upstream)
        let request = FakeRequest(uri)
        onQueue(router) { #expect(router.answer(request)) }

        #expect(request.finished)
        #expect(request.contentType == "public.m3u-playlist")
        #expect(String(decoding: request.data, as: UTF8.self).contains("\(dir)/l_100.ts"))
    }

    @Test("reads again for the next request")
    func readsPerRequest() {
        let upstream = FakeUpstream([liveUrl: body(liveWindow(100))])
        let router = makeRouter(upstream)
        onQueue(router) { _ = router.answer(FakeRequest(uri)) }
        onQueue(router) { _ = router.answer(FakeRequest(uri)) }
        #expect(upstream.reads.count == 2)
    }

    @Test("finishes a failed read with its code and the upstream status")
    func failedRead() {
        let router = makeRouter(FakeUpstream([liveUrl: .status(503)]))
        let request = FakeRequest(uri)
        onQueue(router) { _ = router.answer(request) }

        #expect(request.error?.domain == UriRouter.errorDomain)
        #expect(request.error?.code == UriRouter.ErrorCode.fetchFailed.rawValue)
        #expect(request.error?.userInfo[UriRouter.statusKey] as? Int == 503)
    }

    @Test("leaves a released address unanswered, and reads nothing")
    func releasedAddress() {
        let upstream = FakeUpstream([liveUrl: body(liveWindow(100))])
        let router = makeRouter(upstream, release: true)
        let request = FakeRequest(uri)
        onQueue(router) { #expect(router.answer(request)) }

        #expect(!request.finished)
        #expect(request.error == nil)
        #expect(upstream.reads.isEmpty)
    }

    @Test("cancels the read when AVPlayer cancels the request, and never answers it")
    func cancel() {
        let upstream = FakeUpstream([liveUrl: .hang])
        let router = makeRouter(upstream)
        let request = FakeRequest(uri)
        onQueue(router) { _ = router.answer(request) }
        onQueue(router) { router.cancel(request) }

        #expect(upstream.cancels == 1)
        #expect(!request.finished)
        #expect(request.error == nil)
    }
}
