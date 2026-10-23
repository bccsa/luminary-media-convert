import Foundation
import Testing
@testable import LuminaryPlayerCore

private let keyHex = "000102030405060708090a0b0c0d0e0f"

private let media = """
#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="luminary://key"
#EXTINF:6.0,
https://media.invalid/segment_0.ts
#EXT-X-ENDLIST

"""

private let master = """
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
luminary://asset/1/2.m3u8

"""

private func makeRouter() -> UriRouter {
    let assets = AssetStore()
    assets.put(1, [
        BridgeAsset(uri: "luminary://asset/1/1.m3u8", contentType: "application/vnd.apple.mpegurl", text: master),
        BridgeAsset(uri: "luminary://asset/1/2.m3u8", contentType: "application/vnd.apple.mpegurl", text: media),
    ])
    let holder = KeyHolder()
    holder.set(hex: keyHex)
    return UriRouter(assets: assets, key: holder)
}

@Suite("Cast rewrite")
struct CastRewriteTests {
    private let base = "http://192.168.1.5:8080/abc"

    @Test("bridge addresses become the phone's HTTP ones")
    func rewrites() {
        let text = rewriteForCast(
            "luminary://asset/3/x.m3u8\nURI=\"luminary://key\"\nluminary://live/12", base: base
        )
        #expect(text == "\(base)/a/3/x.m3u8\nURI=\"\(base)/key\"\n\(base)/l/12.m3u8")
    }

    @Test("a longer word starting with key is not the key")
    func keyBoundary() {
        #expect(rewriteForCast("luminary://keyboard", base: base) == "luminary://keyboard")
    }

    @Test("paths map back to bridge addresses, and others to none")
    func paths() {
        #expect(bridgeUri(ofCastPath: "/key") == "luminary://key")
        #expect(bridgeUri(ofCastPath: "/a/1/2.m3u8") == "luminary://asset/1/2.m3u8")
        #expect(bridgeUri(ofCastPath: "/l/7.m3u8") == "luminary://live/7")
        #expect(bridgeUri(ofCastPath: "/a/1/../2.m3u8") == nil)
        #expect(bridgeUri(ofCastPath: "/a/x/2.m3u8") == nil)
        #expect(bridgeUri(ofCastPath: "/other") == nil)
    }

    @Test("a byte range parses, and a suffix range is none")
    func ranges() {
        #expect(CastServer.parseRange("bytes=2-5")?.start == 2)
        #expect(CastServer.parseRange("bytes=2-5")?.end == 5)
        #expect(CastServer.parseRange("bytes=2-")?.end == nil)
        #expect(CastServer.parseRange("bytes=-5") == nil)
    }

    @Test("a private LAN address is one a receiver can reach")
    func lan() {
        if let address = CastServer.lanAddress() { #expect(address.split(separator: ".").count == 4) }
    }
}

@Suite("Cast server over loopback")
struct CastServerTests {
    private func started() async throws -> (CastServer, String) {
        let server = CastServer(router: makeRouter(), address: "127.0.0.1")
        let base: String? = await withCheckedContinuation { continuation in
            server.start { continuation.resume(returning: $0) }
        }
        return (server, try #require(base))
    }

    private func get(_ url: String, method: String = "GET", range: String? = nil) async throws -> (Int, Data, [AnyHashable: Any]) {
        var request = URLRequest(url: try #require(URL(string: url)))
        request.httpMethod = method
        if let range { request.setValue(range, forHTTPHeaderField: "Range") }
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        let http = try #require(response as? HTTPURLResponse)
        return (http.statusCode, data, http.allHeaderFields)
    }

    @Test("serves a playlist with its addresses rewritten, and the key as bytes")
    func serves() async throws {
        let (server, base) = try await started()
        defer { server.stop() }

        let (status, body, headers) = try await get("\(base)/a/1/2.m3u8")
        #expect(status == 200)
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.contains("URI=\"\(base)/key\""))
        #expect(!text.contains("luminary://"))
        #expect(headers["Content-Type"] as? String == "application/vnd.apple.mpegurl")

        let (keyStatus, key, _) = try await get("\(base)/key")
        #expect(keyStatus == 200)
        #expect(key == Data((0..<16).map(UInt8.init)))
    }

    @Test("a master names the media playlist on the server")
    func masterRewritten() async throws {
        let (server, base) = try await started()
        defer { server.stop() }
        let (_, body, _) = try await get("\(base)/a/1/1.m3u8")
        #expect(String(decoding: body, as: UTF8.self).contains("\(base)/a/1/2.m3u8"))
    }

    @Test("a wrong token, an unheld asset and a bad method are refused")
    func refuses() async throws {
        let (server, base) = try await started()
        defer { server.stop() }
        let root = String(base.dropLast(32))
        #expect(try await get("\(root)\(String(repeating: "0", count: 32))/key").0 == 404)
        #expect(try await get("\(base)/a/1/9.m3u8").0 == 404)
        #expect(try await get("\(base)/key", method: "POST").0 == 405)
    }

    @Test("a range answers partially, and HEAD sends no body")
    func ranges() async throws {
        let (server, base) = try await started()
        defer { server.stop() }
        let (status, body, headers) = try await get("\(base)/key", range: "bytes=2-5")
        #expect(status == 206)
        #expect(body == Data([2, 3, 4, 5]))
        #expect(headers["Content-Range"] as? String == "bytes 2-5/16")
        #expect(try await get("\(base)/key", range: "bytes=99-").0 == 416)
        let head = try await get("\(base)/key", method: "HEAD")
        #expect(head.0 == 200)
        #expect(head.1.isEmpty)
    }
}
