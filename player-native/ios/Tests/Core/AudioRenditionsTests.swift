import Testing
import LuminaryPlayerCore

@Suite("Audio tracks from AVPlayer's options")
struct AudioRenditionsTests {
    @Test("lists a language once, however many tiers carry it")
    func oneTrackPerLanguage() {
        // The encoder's two-tier ladder: the same languages, named apart per tier.
        let options = [
            ("en", "HD Audio eng"), ("es", "HD Audio spa"), ("fr", "HD Audio fra"), ("de", "HD Audio deu"),
            ("en", "SD Audio eng"), ("es", "SD Audio spa"), ("fr", "SD Audio fra"), ("de", "SD Audio deu"),
        ]
        let keys = options.map { AudioRenditions.key(language: $0.0, name: $0.1) }
        let tracks = AudioRenditions.tracks(keys: keys)
        #expect(tracks.map(\.id) == ["en", "es", "fr", "de"])
        #expect(tracks.map(\.index) == [0, 1, 2, 3])
    }

    @Test("keys a rendition with no language by its name")
    func noLanguage() {
        #expect(AudioRenditions.key(language: nil, name: "Commentary") == "Commentary")
        #expect(AudioRenditions.key(language: "", name: "Commentary") == "Commentary")
        #expect(AudioRenditions.key(language: "en", name: "English") == "en")
    }

    @Test("keeps the order the keys first appear in")
    func firstSeenOrder() {
        let tracks = AudioRenditions.tracks(keys: ["fr", "en", "fr"])
        #expect(tracks.map(\.id) == ["fr", "en"])
        #expect(tracks.map(\.index) == [0, 1])
    }

    @Test("lists nothing for a stream without audio options")
    func empty() {
        #expect(AudioRenditions.tracks(keys: []).isEmpty)
    }
}
