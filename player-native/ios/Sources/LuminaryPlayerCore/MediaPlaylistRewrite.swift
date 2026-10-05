import Foundation

/// The media-playlist rewrite, ported from `player-core/src/pipeline/rewrite-media.ts`: string
/// work, so a line it does not recognise is reproduced exactly.
///
/// - `#EXT-X-KEY` with `METHOD=NONE` → untouched.
/// - `#EXT-X-KEY` with any other method → `URI` replaced by `keyUri` (appended when missing);
///   `IV=` and every other attribute untouched. No `keyUri` leaves key lines as written.
/// - Every other `URI="…"` attribute, and every segment line → absolutized against `playlistUrl`.
/// - A line's trailing carriage return is kept.
func rewriteMediaPlaylist(_ text: String, playlistUrl: String, keyUri: String?) -> String {
    let resolve = Absolutizer(base: URL(string: playlistUrl))
    // Split by UTF-16 unit: as Characters, "\r\n" is one and would never split on "\n".
    return text
        .components(separatedBy: "\n")
        .map { line -> String in
            let cr = line.hasSuffix("\r")
            let body = cr ? String(line.utf16.dropLast())! : line
            let rewritten = rewriteBody(body, keyUri: keyUri, resolve: resolve)
            return cr ? rewritten + "\r" : rewritten
        }
        .joined(separator: "\n")
}

/// Some `#EXT-X-KEY` declares a method other than `NONE`.
func hasAes128Key(_ text: String) -> Bool {
    text.components(separatedBy: "\n").contains { line in
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(keyTag) else { return false }
        let method = firstCapture(methodAttribute, in: String(trimmed.dropFirst(keyTag.count)))
        return method?.trimmingCharacters(in: .whitespaces) != "NONE"
    }
}

private let keyTag = "#EXT-X-KEY:"
private let uriAttribute = try! NSRegularExpression(pattern: #"URI="([^"]*)""#)
private let methodNone = try! NSRegularExpression(pattern: #"(?:^|,)\s*METHOD=NONE(?:,|$)"#)
private let methodAttribute = try! NSRegularExpression(pattern: #"(?:^|,)\s*METHOD=([^,]*)"#)

private func rewriteBody(_ line: String, keyUri: String?, resolve: Absolutizer) -> String {
    if line.isEmpty { return line }
    if !line.hasPrefix("#") { return resolve(line) }
    if line.hasPrefix(keyTag) { return rewriteKeyLine(line, keyUri: keyUri) }
    if !line.contains(#"URI=""#) { return line }

    let ns = line as NSString
    var result = line
    for match in uriAttribute.matches(in: line, range: NSRange(location: 0, length: ns.length)).reversed() {
        let uri = ns.substring(with: match.range(at: 1))
        let replaced = (result as NSString).replacingCharacters(in: match.range, with: #"URI="\#(resolve(uri))""#)
        result = replaced
    }
    return result
}

private func rewriteKeyLine(_ line: String, keyUri: String?) -> String {
    guard let keyUri else { return line }
    let attrs = String(line.dropFirst(keyTag.count))
    if matches(methodNone, attrs) { return line }

    let ns = line as NSString
    if let match = uriAttribute.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
        return ns.replacingCharacters(in: match.range, with: #"URI="\#(keyUri)""#)
    }
    // A non-NONE key with no URI is malformed, but the key it is missing is the one supplied.
    return #"\#(line),URI="\#(keyUri)""#
}

private func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
}

private func firstCapture(_ regex: NSRegularExpression, in text: String) -> String? {
    let ns = text as NSString
    guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    return ns.substring(with: match.range(at: 1))
}

/// Resolves URIs against one base, remembering the last: byte-range output names the same chunk
/// object on a hundred consecutive segments.
private final class Absolutizer {
    private let base: URL?
    private var lastUri: String?
    private var lastAbsolute = ""

    init(base: URL?) {
        self.base = base
    }

    func callAsFunction(_ uri: String) -> String {
        if uri != lastUri {
            lastAbsolute = absolutize(uri)
            lastUri = uri
        }
        return lastAbsolute
    }

    private func absolutize(_ uri: String) -> String {
        if uri.isEmpty { return uri }
        let lower = uri.lowercased()
        if lower.hasPrefix("blob:") || lower.hasPrefix("data:") { return uri }
        guard let base, let url = URL(string: uri, relativeTo: base) else { return uri }
        return url.absoluteURL.standardized.absoluteString
    }
}
