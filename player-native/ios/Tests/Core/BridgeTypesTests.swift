import Testing
import LuminaryPlayerCore

/// Arguments a call rejects as `invalid-argument` rather than trapping on: the bridge promises a
/// refused call changes nothing, and a crash changes everything.
@Suite("Bridge arguments")
struct BridgeTypesTests {
    private func load(maxReloadAttempts: JSON) -> [String: JSON] {
        [
            "playerId": .string("player-1"),
            "loadId": .string("load-1"),
            "generation": .number(0),
            "masterUri": .string("luminary://asset/0/master.m3u8"),
            "assets": .array([]),
            "recovery": .object([
                "escalationWindowMs": .number(10_000),
                "maxReloadAttempts": maxReloadAttempts,
                "reloadDelaysMs": .array([.number(2_000)]),
            ]),
        ]
    }

    private func warm(warmBytes: JSON) -> [String: JSON] {
        [
            "playerId": .string("player-1"),
            "loadId": .string("load-1"),
            "schedules": .array([]),
            "leadSeconds": .number(60),
            "warmBytes": warmBytes,
        ]
    }

    private func rejection(_ method: String, _ args: [String: JSON]) -> BridgeErrorCode? {
        do {
            _ = try BridgeCall.decode(method, args)
            return nil
        } catch let rejection as BridgeRejection {
            return rejection.code
        } catch {
            return nil
        }
    }

    @Test("a reload count or a byte count past what fits is refused, not trapped on")
    func countsAreBounded() {
        for huge: JSON in [.number(1e19), .number(-1), .number(2.5), .number(Double(Int32.max) + 1)] {
            #expect(rejection("load", load(maxReloadAttempts: huge)) == .invalidArgument)
            #expect(rejection("warmChunks", warm(warmBytes: huge)) == .invalidArgument)
        }
    }

    @Test("a subtitle choice carries the name and the language, either of which may be missing")
    func subtitleChoiceDecodes() throws {
        guard case .setSubtitleTrack(_, let label, let language) = try BridgeCall.decode("setSubtitleTrack", [
            "playerId": .string("p"), "label": .string("English"), "language": .string("en"),
        ]) else {
            Issue.record("not a subtitle choice")
            return
        }
        #expect(label == "English")
        #expect(language == "en")
        guard case .setSubtitleTrack(_, let off, let none) = try BridgeCall.decode("setSubtitleTrack", ["playerId": .string("p")]) else {
            Issue.record("not a subtitle choice")
            return
        }
        #expect(off == nil)
        #expect(none == nil)
    }

    @Test("a sleep timer carries the time it stops at, or none to clear it, and refuses a time that is not a number")
    func sleepTimerDecodes() throws {
        guard case .setSleepTimer(let id, let endsAt) = try BridgeCall.decode("setSleepTimer", [
            "playerId": .string("p"), "endsAt": .number(1_800_000_000_000),
        ]) else {
            Issue.record("not a sleep timer")
            return
        }
        #expect(id == "p")
        #expect(endsAt == 1_800_000_000_000)

        guard case .setSleepTimer(_, let cleared) = try BridgeCall.decode("setSleepTimer", ["playerId": .string("p")]) else {
            Issue.record("not a sleep timer")
            return
        }
        #expect(cleared == nil)
        #expect(rejection("setSleepTimer", ["playerId": .string("p"), "endsAt": .string("soon")]) == .invalidArgument)
    }

    @Test("a sleep timer is refused where the platform has none, and is reported only where it has")
    func sleepTimerCapability() {
        let none = BridgeCapabilities()
        #expect(none[keyPath: BridgeCall.capability(of: "setSleepTimer")!] == false)
        #expect(none.json.objectValue?["sleepTimer"] == nil)

        var some = BridgeCapabilities()
        some.sleepTimer = true
        #expect(some[keyPath: BridgeCall.capability(of: "setSleepTimer")!] == true)
        #expect(some.json.objectValue?["sleepTimer"] != nil)
    }

    @Test("now playing carries the post's artwork and the host's stand-in for it")
    func nowPlayingDecodes() throws {
        var args = load(maxReloadAttempts: .number(3))
        args["nowPlaying"] = .object([
            "title": .string("Friday evening"),
            "artworkUrl": .string("https://cdn.example.com/a.webp"),
            "fallbackArtworkUrl": .string("data:image/jpeg;base64,AAAA"),
        ])
        guard case .load(let decoded) = try BridgeCall.decode("load", args) else {
            Issue.record("not a load")
            return
        }
        #expect(decoded.nowPlaying?.title == "Friday evening")
        #expect(decoded.nowPlaying?.artworkUrl == "https://cdn.example.com/a.webp")
        #expect(decoded.nowPlaying?.fallbackArtworkUrl == "data:image/jpeg;base64,AAAA")

        args["nowPlaying"] = .object(["title": .string("No picture")])
        guard case .load(let bare) = try BridgeCall.decode("load", args) else {
            Issue.record("not a load")
            return
        }
        #expect(bare.nowPlaying?.artworkUrl == nil)
        #expect(bare.nowPlaying?.fallbackArtworkUrl == nil)
    }

    @Test("the scrub frames' VTT address decodes, and is absent when none is sent")
    func thumbnailsDecode() throws {
        var args = load(maxReloadAttempts: .number(3))
        guard case .load(let without) = try BridgeCall.decode("load", args) else {
            Issue.record("not a load")
            return
        }
        #expect(without.thumbnailsUrl == nil)

        args["thumbnailsUrl"] = .string("https://cdn.example.com/m/thumbnails/thumbnails.vtt")
        guard case .load(let with) = try BridgeCall.decode("load", args) else {
            Issue.record("not a load")
            return
        }
        #expect(with.thumbnailsUrl == "https://cdn.example.com/m/thumbnails/thumbnails.vtt")
    }

    @Test("the page's picture says whether it sits in front, the band under it, and whether it is covered")
    func inlineFrameDecode() throws {
        let frame: [String: JSON] = ["x": .number(0), "y": .number(40), "width": .number(390), "height": .number(219)]
        guard case .setInlineFrame(_, let plain?) = try BridgeCall.decode("setInlineFrame", ["playerId": .string("p"), "frame": .object(frame)]) else {
            Issue.record("not a frame")
            return
        }
        #expect(!plain.front && plain.captionHeight == 0 && !plain.captionsHidden)

        var covered = frame
        covered["captionHeight"] = .number(64)
        covered["captionsHidden"] = .bool(true)
        guard case .setInlineFrame(_, let flagged?) = try BridgeCall.decode("setInlineFrame", ["playerId": .string("p"), "frame": .object(covered)]) else {
            Issue.record("not a frame")
            return
        }
        #expect(flagged.captionHeight == 64 && flagged.captionsHidden)
    }

    @Test("counts that fit decode as they are")
    func countsDecode() throws {
        guard case .load(let args) = try BridgeCall.decode("load", load(maxReloadAttempts: .number(3))) else {
            Issue.record("not a load")
            return
        }
        #expect(args.recovery.maxReloadAttempts == 3)
        guard case .warmChunks(_, _, _, _, let bytes) = try BridgeCall.decode("warmChunks", warm(warmBytes: .number(65_536))) else {
            Issue.record("not a warmChunks")
            return
        }
        #expect(bytes == 65_536)
    }
}

@Suite("Bridge arguments: keys and schedules")
struct BridgeKeyAndScheduleTests {
    @Test("a key is 32 ASCII hex characters: fullwidth digits are refused")
    func asciiHexOnly() {
        #expect(isKeyHex("00112233445566778899aabbccddeeff"))
        #expect(isKeyHex("00112233445566778899AABBCCDDEEFF"))
        #expect(!isKeyHex(String(repeating: "Ａ", count: 32)))
        #expect(!isKeyHex("0011223344556677889900112233445g"))
        #expect(!isKeyHex("0011"))
    }

    @Test("a key that does not decode is no key, not a key of zeros")
    func holderRefusesBadHex() {
        let holder = KeyHolder()
        holder.set(hex: "00112233445566778899aabbccddeeff")
        #expect(holder.copy()?.count == 16)
        holder.set(hex: String(repeating: "Ａ", count: 32))
        #expect(holder.copy() == nil)
        holder.set(hex: "abc")
        #expect(holder.copy() == nil)
    }

    @Test("a schedule with an incomplete boundary is refused, not thinned out")
    func incompleteBoundary() {
        func warm(_ boundary: JSON) -> BridgeErrorCode? {
            do {
                _ = try BridgeCall.decode("warmChunks", [
                    "playerId": .string("p"), "loadId": .string("l"), "leadSeconds": .number(60), "warmBytes": .number(1024),
                    "schedules": .array([.array([boundary])]),
                ])
                return nil
            } catch let rejection as BridgeRejection { return rejection.code } catch { return nil }
        }
        #expect(warm(.object(["url": .string("u"), "start": .number(0), "end": .number(20)])) == nil)
        #expect(warm(.object(["url": .string("u"), "start": .number(0)])) == .invalidArgument)
        #expect(warm(.object(["url": .number(5), "start": .number(0), "end": .number(20)])) == .invalidArgument)
    }
}
