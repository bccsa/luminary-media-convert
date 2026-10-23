import Foundation

/*
 * What an AirPlay receiver is given in place of the bridge's own addresses. The receiver fetches
 * the stream itself and cannot reach `luminary://`, so while AirPlay is active the phone answers
 * for those addresses over HTTP (``CastServer``), and the text it serves names them by their HTTP
 * form.
 *
 *   luminary://asset/<generation>/<name>  →  <base>/a/<generation>/<name>
 *   luminary://key                        →  <base>/key
 *   luminary://live/<n>                   →  <base>/l/<n>.m3u8
 *
 * `<base>` is `http://<phone>:<port>/<token>`. Segment and init URLs are already absolute
 * `https://` after the munge and are left alone.
 */

/// `text` with every bridge address replaced by the HTTP address the phone serves it at.
func rewriteForCast(_ text: String, base: String) -> String {
    var out = text.replacingOccurrences(of: assetUriPrefix, with: "\(base)/a/")
    out = out.replacingOccurrences(
        of: "luminary://key(?![A-Za-z0-9_])", with: "\(base)/key", options: .regularExpression
    )
    out = out.replacingOccurrences(
        of: "luminary://live/(\\d+)", with: "\(base)/l/$1.m3u8", options: .regularExpression
    )
    return out
}

/// The bridge address a request path under the token stands for, or nil for a path that is none.
func bridgeUri(ofCastPath path: String) -> String? {
    if path == "/key" { return keyUri }
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    // "", "a", "<generation>", "<name>"
    if parts.count == 4, parts[0].isEmpty, parts[1] == "a", isDigits(parts[2]), isAssetName(parts[3]) {
        return "\(assetUriPrefix)\(parts[2])/\(parts[3])"
    }
    // "", "l", "<n>.m3u8"
    if parts.count == 3, parts[0].isEmpty, parts[1] == "l", parts[2].hasSuffix(".m3u8") {
        let id = String(parts[2].dropLast(".m3u8".count))
        if isDigits(id) { return "\(liveUriPrefix)\(id)" }
    }
    return nil
}

private func isDigits(_ text: String) -> Bool {
    !text.isEmpty && text.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

private func isAssetName(_ text: String) -> Bool {
    !text.isEmpty && text.utf8.allSatisfy { byte in
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
            || byte == 0x2E || byte == 0x5F || byte == 0x2D
    }
}
