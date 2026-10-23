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
    let resolve = Absolutizer(base: playlistUrl)
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

/// Some `#EXT-X-KEY` declares a method other than `NONE`. A key line naming no method, or an
/// empty one, declares nothing: as in `hls-core`'s parser, which `keyApplies` reads it through.
func hasAes128Key(_ text: String) -> Bool {
    text.components(separatedBy: "\n").contains { line in
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(keyTag) else { return false }
        guard let method = firstCapture(methodAttribute, in: String(trimmed.dropFirst(keyTag.count)))?
            .trimmingCharacters(in: .whitespaces), !method.isEmpty else { return false }
        return method != "NONE"
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
    // An empty key URI names no key, as it does for the TypeScript original (`!keyUri`).
    guard let keyUri, !keyUri.isEmpty else { return line }
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
    private let base: String?
    private var lastUri: String?
    private var lastAbsolute = ""

    init(base: String?) {
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
        guard let base else { return uri }
        return resolveReference(uri, against: base) ?? uri
    }
}

/// `new URL(reference, base).href` for the references a playlist holds, by RFC 3986 on the
/// strings: Foundation's `URL` re-encodes `[ ] |` (breaking a signed query string), keeps a
/// trailing space as `%20`, and on iOS 15 and 16 refuses a URI with a space or a non-ASCII
/// character, which would leave the line relative to `luminary://live/…`. Nil when `base` is
/// not an absolute URL.
func resolveReference(_ reference: String, against base: String) -> String? {
    // The URL parser strips leading and trailing C0 controls and spaces, and tabs and newlines
    // anywhere.
    let trimSet = CharacterSet(charactersIn: "\u{0}"..."\u{20}")
    let reference = reference.trimmingCharacters(in: trimSet).filter { $0 != "\t" && $0 != "\n" && $0 != "\r" }
    guard let root = parseAbsolute(base.trimmingCharacters(in: trimSet)) else { return nil }
    if reference.isEmpty { return root.href(path: root.path, query: root.query) }
    if hasScheme(reference) || reference.hasPrefix("//") {
        // Already absolute (or scheme-relative): normalised, not resolved.
        let absolute = reference.hasPrefix("//") ? root.scheme + ":" + reference : reference
        guard let parsed = parseAbsolute(absolute) else { return reference }
        let fragment = absolute.firstIndex(of: "#").map { encode(String(absolute[$0...])) } ?? ""
        return parsed.href(path: removeDotSegments(parsed.path), query: parsed.query) + fragment
    }

    var rest = reference
    var fragment = ""
    if let hash = rest.firstIndex(of: "#") {
        fragment = String(rest[hash...])
        rest = String(rest[..<hash])
    }
    var query: String? = nil
    if let mark = rest.firstIndex(of: "?") {
        query = String(rest[mark...].dropFirst())
        rest = String(rest[..<mark])
    }

    let path: String
    if rest.isEmpty {
        path = root.path
        if query == nil { query = root.query }
    } else if rest.hasPrefix("/") {
        path = removeDotSegments(rest)
    } else {
        let directory = root.path.range(of: "/", options: .backwards).map { String(root.path[..<$0.upperBound]) } ?? "/"
        path = removeDotSegments(directory + rest)
    }
    return root.href(path: encode(path), query: query.map(encode)) + encode(fragment)
}

private struct Root {
    let scheme: String
    let authority: String
    let path: String
    let query: String?

    func href(path: String, query: String?) -> String {
        "\(scheme)://\(authority)\(path)" + (query.map { "?" + $0 } ?? "")
    }
}

private func hasScheme(_ text: String) -> Bool {
    guard let colon = text.firstIndex(of: ":"), colon != text.startIndex else { return false }
    let name = text[..<colon]
    guard let first = name.first, first.isASCII, first.isLetter else { return false }
    return name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "+-.".contains($0)) }
}

/// Scheme and host lowercased, a default port dropped, as the URL parser does.
private func parseAbsolute(_ url: String) -> Root? {
    guard let separator = url.range(of: "://") else { return nil }
    let scheme = url[..<separator.lowerBound].lowercased()
    guard hasScheme(String(scheme) + ":") else { return nil }
    var rest = String(url[separator.upperBound...])
    if let hash = rest.firstIndex(of: "#") { rest = String(rest[..<hash]) }
    var query: String? = nil
    if let mark = rest.firstIndex(of: "?") {
        query = String(rest[mark...].dropFirst())
        rest = String(rest[..<mark])
    }
    let slash = rest.firstIndex(of: "/") ?? rest.endIndex
    var authority = String(rest[..<slash]).lowercased()
    let path = slash == rest.endIndex ? "/" : String(rest[slash...])
    if (scheme == "https" && authority.hasSuffix(":443")) || (scheme == "http" && authority.hasSuffix(":80")) {
        authority = String(authority[..<authority.lastIndex(of: ":")!])
    }
    guard !authority.isEmpty else { return nil }
    return Root(scheme: String(scheme), authority: authority, path: encode(path), query: query.map(encode))
}

/// `.` and `..` segments removed (RFC 3986 §5.2.4), the way `new URL` does.
private func removeDotSegments(_ path: String) -> String {
    var output: [Substring] = []
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
    for (index, segment) in segments.enumerated() {
        let last = index == segments.count - 1
        switch segment.lowercased() {
        case ".", "%2e":
            if last { output.append("") }
        case "..", ".%2e", "%2e.", "%2e%2e":
            if !output.isEmpty { output.removeLast() }
            if last { output.append("") }
        default:
            output.append(segment)
        }
    }
    return "/" + output.joined(separator: "/")
}

/// Percent-encodes what the URL parser encodes in a path or query that a playlist is likely to
/// hold: spaces, controls and non-ASCII characters. Everything else, `[ ] |` included, stays.
private func encode(_ text: String) -> String {
    var result = ""
    for scalar in text.unicodeScalars {
        if scalar.value > 0x20, scalar.value < 0x7F, scalar != "\"", scalar != "<", scalar != ">", scalar != "`", scalar != "{", scalar != "}" {
            result.unicodeScalars.append(scalar)
        } else {
            for byte in String(scalar).utf8 { result += String(format: "%%%02X", byte) }
        }
    }
    return result
}
