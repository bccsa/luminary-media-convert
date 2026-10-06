import AVFoundation
import Foundation
import Testing
@testable import LuminaryPlayerCore

private let keyHex = "000102030405060708090a0b0c0d0e0f"

private let master = """
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
luminary://asset/1/2.m3u8

"""

private let media = """
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x00000000000000000000000000000001
#EXTINF:6.000000,
https://media.invalid/segment_0.ts
#EXTINF:6.000000,
https://media.invalid/segment_1.ts
#EXT-X-ENDLIST

"""

private func makeRouter(key: String? = keyHex) -> UriRouter {
    let assets = AssetStore()
    assets.put(1, [
        BridgeAsset(uri: "luminary://asset/1/1.m3u8", contentType: "application/vnd.apple.mpegurl", text: master),
        BridgeAsset(uri: "luminary://asset/1/2.m3u8", contentType: "application/vnd.apple.mpegurl", text: media),
        BridgeAsset(uri: "luminary://asset/1/3.vtt", contentType: "text/vtt", text: "WEBVTT\n"),
    ])
    let holder = KeyHolder()
    holder.set(hex: key)
    return UriRouter(assets: assets, key: holder)
}

/// A request as AVFoundation would make it, recording how it was answered.
private final class FakeRequest: LoadingRequest {
    let uri: String?
    var id: ObjectIdentifier { ObjectIdentifier(self) }
    let wantsContentInformation: Bool
    let dataRange: (offset: Int64, length: Int?)?

    var contentType: String?
    var contentLength: Int64?
    var data = Data()
    var finished = false
    var error: NSError?

    init(_ uri: String, contentInformation: Bool = true, range: (offset: Int64, length: Int?)? = (0, nil)) {
        self.uri = uri
        wantsContentInformation = contentInformation
        dataRange = range
    }

    func setContentInformation(contentType: String, contentLength: Int64) {
        self.contentType = contentType
        self.contentLength = contentLength
    }

    func respond(with data: Data) { self.data.append(data) }
    func finish() { finished = true }
    func finish(with error: Error) { self.error = error as NSError }
}

@Suite("UriRouter as a resource-loader delegate")
struct UriRouterTests {
    @Test("serves a playlist whole, with its type as a UTI")
    func servesPlaylist() {
        let request = FakeRequest("luminary://asset/1/2.m3u8")
        #expect(makeRouter().answer(request))
        #expect(request.finished)
        #expect(request.contentType == "public.m3u-playlist")
        #expect(request.contentLength == Int64(media.utf8.count))
        #expect(String(decoding: request.data, as: UTF8.self) == media)
    }

    @Test("answers a request for data alone, without the content type")
    func answersDataOnly() {
        let request = FakeRequest("luminary://asset/1/2.m3u8", contentInformation: false)
        #expect(makeRouter().answer(request))
        #expect(request.finished)
        #expect(request.contentType == nil)
        #expect(String(decoding: request.data, as: UTF8.self) == media)
    }

    @Test("honours a requested range")
    func honoursRange() {
        let bounded = FakeRequest("luminary://asset/1/2.m3u8", range: (7, 10))
        let toEnd = FakeRequest("luminary://asset/1/2.m3u8", range: (7, nil))
        let router = makeRouter()
        #expect(router.answer(bounded))
        #expect(router.answer(toEnd))
        let bytes = Array(media.utf8)
        #expect(Array(bounded.data) == Array(bytes[7..<17]))
        #expect(Array(toEnd.data) == Array(bytes[7...]))
    }

    @Test("reports a content-type question alone with no data")
    func contentInformationOnly() {
        let request = FakeRequest("luminary://asset/1/3.vtt", range: nil)
        #expect(makeRouter().answer(request))
        #expect(request.finished)
        #expect(request.contentLength == Int64("WEBVTT\n".utf8.count))
        #expect(request.data.isEmpty)
    }

    @Test("serves the key's 16 bytes")
    func servesKey() {
        let request = FakeRequest("luminary://key")
        #expect(makeRouter().answer(request))
        #expect(request.contentType == "public.data")
        #expect(Array(request.data) == Array(0..<16))
    }

    @Test("fails a missing key as key-required, and a missing asset as not-found")
    func failsMissing() {
        let noKey = FakeRequest("luminary://key")
        let noAsset = FakeRequest("luminary://asset/1/99.m3u8")
        #expect(makeRouter(key: nil).answer(noKey))
        #expect(makeRouter().answer(noAsset))
        #expect(noKey.error?.domain == UriRouter.errorDomain)
        #expect(noKey.error?.code == UriRouter.ErrorCode.keyRequired.rawValue)
        #expect(noAsset.error?.code == UriRouter.ErrorCode.notFound.rawValue)
        #expect(!noKey.finished && !noAsset.finished)
    }

    @Test("leaves anything outside the scheme to AVFoundation")
    func declinesOtherSchemes() {
        let request = FakeRequest("https://media.invalid/segment_0.ts")
        #expect(!makeRouter().answer(request))
        #expect(!request.finished && request.error == nil)
    }

    @Test("maps the bridge's MIME types to UTIs")
    func mapsTypes() {
        #expect(UriRouter.uti(forMimeType: "application/vnd.apple.mpegurl") == "public.m3u-playlist")
        #expect(UriRouter.uti(forMimeType: "application/octet-stream") == "public.data")
        #expect(UriRouter.uti(forMimeType: "application/x-unknown-to-anyone") == "public.data")
    }

    @Test("feeds a real AVURLAsset the master and media playlists")
    func realAsset() async throws {
        let router = makeRouter()
        let asset = AVURLAsset(url: URL(string: "luminary://asset/1/1.m3u8")!)
        asset.resourceLoader.setDelegate(router, queue: router.queue)
        let duration = try await asset.load(.duration)
        #expect(duration.seconds == 12)
    }
}
