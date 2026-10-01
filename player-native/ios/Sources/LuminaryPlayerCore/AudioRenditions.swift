/// The audio tracks the bridge lists, from the options AVPlayer offers.
///
/// AVPlayer lists one option per HLS audio rendition, so a ladder whose audio comes in more than
/// one group (a tier per video quality) lists every language once per tier: four languages in two
/// tiers are eight options, and the encoder names them apart ("HD Audio eng", "SD Audio eng").
/// The bridge lists one track per language: renditions sharing a `LANGUAGE` are the same track,
/// and AVPlayer moves between them by itself as the variant changes. A rendition with no language
/// is a track of its own, keyed by its `NAME`. The key is the track's id, so the same master gives
/// the same ids after a reattach.
public enum AudioRenditions {
    /// The key a rendition is listed under: its language, else its name.
    public static func key(language: String?, name: String) -> String {
        guard let language, !language.isEmpty else { return name }
        return language
    }

    /// One entry per distinct key, in the order the keys first appear, with the index of the
    /// first option carrying it: the one a selection of that track picks.
    public static func tracks(keys: [String]) -> [(id: String, index: Int)] {
        var seen: Set<String> = []
        return keys.enumerated().compactMap { index, key in
            seen.insert(key).inserted ? (key, index) : nil
        }
    }
}
