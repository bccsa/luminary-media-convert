import Foundation
import Testing
import LuminaryPlayerCore

@Suite("JSON to and from Capacitor's Foundation values")
struct JSONFoundationTests {
    @Test("tells a boolean from a number, though both arrive as NSNumber")
    func booleansAndNumbers() {
        let options: [AnyHashable: Any] = [
            "exact": NSNumber(value: true),
            "position": NSNumber(value: 1),
            "rate": 1.5,
            "flag": false,
        ]
        #expect(JSON(any: options) == .object([
            "exact": .bool(true),
            "position": .number(1),
            "rate": .number(1.5),
            "flag": .bool(false),
        ]))
    }

    @Test("reads nested arrays, objects and null")
    func nested() {
        let options: [AnyHashable: Any] = [
            "assets": [["uri": "luminary://asset/1/1.m3u8", "text": "#EXTM3U"]],
            "nowPlaying": NSNull(),
        ]
        #expect(JSON(any: options) == .object([
            "assets": .array([.object(["uri": .string("luminary://asset/1/1.m3u8"), "text": .string("#EXTM3U")])]),
            "nowPlaying": .null,
        ]))
    }

    @Test("round-trips through the Foundation value")
    func roundTrip() {
        let json: JSON = .object([
            "playerId": .string("player-1"),
            "tracks": .array([.object(["id": .string("English"), "lang": .string("en")])]),
            "activeId": .null,
            "fatal": .bool(true),
            "duration": .number(7200),
        ])
        #expect(JSON(any: json.anyValue) == json)
    }
}
