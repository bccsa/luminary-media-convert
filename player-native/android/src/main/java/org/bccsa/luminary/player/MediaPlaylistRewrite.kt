package org.bccsa.luminary.player

/*
 * The media-playlist rewrite, ported from `player-core/src/pipeline/rewrite-media.ts` and the Swift
 * port as string work, so a line it does not recognise is reproduced exactly.
 *
 * - `#EXT-X-KEY` with `METHOD=NONE` → untouched.
 * - `#EXT-X-KEY` with any other method → `URI` replaced by `keyUri` (appended when missing); `IV=`
 *   and every other attribute untouched. No `keyUri` leaves key lines as written.
 * - Every other `URI="…"` attribute, and every segment line → absolutized against `playlistUrl`.
 * - A line's trailing carriage return is kept.
 */

private const val KEY_TAG = "#EXT-X-KEY:"
private val URI_ATTRIBUTE = Regex("URI=\"([^\"]*)\"")
private val METHOD_NONE = Regex("(?:^|,)\\s*METHOD=NONE(?:,|$)")
private val METHOD_ATTRIBUTE = Regex("(?:^|,)\\s*METHOD=([^,]*)")

fun rewriteMediaPlaylist(text: String, playlistUrl: String, keyUri: String?): String {
    val resolve = Absolutizer(playlistUrl)
    return text.split("\n").joinToString("\n") { line ->
        val cr = line.endsWith("\r")
        val rewritten = rewriteBody(if (cr) line.dropLast(1) else line, keyUri, resolve)
        if (cr) "$rewritten\r" else rewritten
    }
}

/**
 * Some `#EXT-X-KEY` declares a method other than `NONE`. A key line naming no method, or an empty
 * one, declares nothing: as in `hls-core`'s parser, which `keyApplies` reads it through.
 */
fun hasAes128Key(text: String): Boolean = text.split("\n").any { line ->
    val trimmed = line.trim()
    if (!trimmed.startsWith(KEY_TAG)) return@any false
    val method = METHOD_ATTRIBUTE.find(trimmed.removePrefix(KEY_TAG))?.groupValues?.get(1)?.trim()
    !method.isNullOrEmpty() && method != "NONE"
}

private fun rewriteBody(line: String, keyUri: String?, resolve: Absolutizer): String {
    if (line.isEmpty()) return line
    if (!line.startsWith("#")) return resolve(line)
    if (line.startsWith(KEY_TAG)) return rewriteKeyLine(line, keyUri)
    if (!line.contains("URI=\"")) return line
    return URI_ATTRIBUTE.replace(line) { "URI=\"${resolve(it.groupValues[1])}\"" }
}

private fun rewriteKeyLine(line: String, keyUri: String?): String {
    // An empty key URI names no key, as it does for the TypeScript original (`!keyUri`).
    if (keyUri.isNullOrEmpty()) return line
    if (METHOD_NONE.containsMatchIn(line.removePrefix(KEY_TAG))) return line

    val uri = URI_ATTRIBUTE.find(line)
    if (uri != null) return line.substring(0, uri.range.first) + "URI=\"$keyUri\"" + line.substring(uri.range.last + 1)
    // A non-NONE key with no URI is malformed, but the key it is missing is the one supplied.
    return "$line,URI=\"$keyUri\""
}

/**
 * Resolves URIs against one base, remembering the last: byte-range output names the same chunk
 * object on a hundred consecutive segments.
 */
private class Absolutizer(private val base: String?) {
    private var lastUri: String? = null
    private var lastAbsolute = ""

    operator fun invoke(uri: String): String {
        if (uri != lastUri) {
            lastAbsolute = absolutize(uri)
            lastUri = uri
        }
        return lastAbsolute
    }

    private fun absolutize(uri: String): String {
        if (uri.isEmpty()) return uri
        val lower = uri.lowercase()
        if (lower.startsWith("blob:") || lower.startsWith("data:")) return uri
        val base = base ?: return uri
        return resolveReference(uri, base) ?: uri
    }
}

/**
 * `new URL(reference, base).href` for the references a playlist holds, by RFC 3986 on the strings:
 * `java.net.URI` refuses a space or a non-ASCII character and re-encodes in places the browser
 * does not, which would break a signed query string. Null when [base] is not an absolute URL.
 */
fun resolveReference(reference: String, base: String): String? {
    // The URL parser strips leading and trailing C0 controls and spaces, and tabs and newlines anywhere.
    val ref = reference.trim { it.code <= 0x20 }.filter { it != '\t' && it != '\n' && it != '\r' }
    val root = parseAbsolute(base.trim { it.code <= 0x20 }) ?: return null
    if (ref.isEmpty()) return root.href(root.path, root.query)
    if (hasScheme(ref) || ref.startsWith("//")) {
        // Already absolute (or scheme-relative): normalised, not resolved.
        val absolute = if (ref.startsWith("//")) root.scheme + ":" + ref else ref
        val parsed = parseAbsolute(absolute) ?: return ref
        val hash = absolute.indexOf('#')
        val fragment = if (hash >= 0) encode(absolute.substring(hash)) else ""
        return parsed.href(removeDotSegments(parsed.path), parsed.query) + fragment
    }

    var rest = ref
    var fragment = ""
    val hash = rest.indexOf('#')
    if (hash >= 0) {
        fragment = rest.substring(hash)
        rest = rest.substring(0, hash)
    }
    var query: String? = null
    val mark = rest.indexOf('?')
    if (mark >= 0) {
        query = rest.substring(mark + 1)
        rest = rest.substring(0, mark)
    }

    val path = when {
        rest.isEmpty() -> {
            if (query == null) query = root.query
            root.path
        }
        rest.startsWith("/") -> removeDotSegments(rest)
        else -> {
            val slash = root.path.lastIndexOf('/')
            val directory = if (slash >= 0) root.path.substring(0, slash + 1) else "/"
            removeDotSegments(directory + rest)
        }
    }
    return root.href(encode(path), query?.let(::encode)) + encode(fragment)
}

private class Root(val scheme: String, val authority: String, val path: String, val query: String?) {
    fun href(path: String, query: String?) = "$scheme://$authority$path" + (query?.let { "?$it" } ?: "")
}

private fun hasScheme(text: String): Boolean {
    val colon = text.indexOf(':')
    if (colon <= 0) return false
    val name = text.substring(0, colon)
    if (!(name[0].isAsciiLetter())) return false
    return name.all { it.isAsciiLetter() || it in '0'..'9' || it in "+-." }
}

private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'

/** Scheme and host lowercased, a default port dropped, as the URL parser does. */
private fun parseAbsolute(url: String): Root? {
    val separator = url.indexOf("://")
    if (separator < 0) return null
    val scheme = url.substring(0, separator).lowercase()
    if (!hasScheme("$scheme:")) return null
    var rest = url.substring(separator + 3)
    val hash = rest.indexOf('#')
    if (hash >= 0) rest = rest.substring(0, hash)
    var query: String? = null
    val mark = rest.indexOf('?')
    if (mark >= 0) {
        query = rest.substring(mark + 1)
        rest = rest.substring(0, mark)
    }
    val slash = rest.indexOf('/').let { if (it < 0) rest.length else it }
    var authority = rest.substring(0, slash).lowercase()
    val path = if (slash == rest.length) "/" else rest.substring(slash)
    if ((scheme == "https" && authority.endsWith(":443")) || (scheme == "http" && authority.endsWith(":80"))) {
        authority = authority.substring(0, authority.lastIndexOf(':'))
    }
    if (authority.isEmpty()) return null
    return Root(scheme, authority, encode(path), query?.let(::encode))
}

/** `.` and `..` segments removed (RFC 3986 §5.2.4), the way `new URL` does. */
private fun removeDotSegments(path: String): String {
    val output = ArrayList<String>()
    val segments = path.split("/").drop(1)
    segments.forEachIndexed { index, segment ->
        val last = index == segments.size - 1
        when (segment.lowercase()) {
            ".", "%2e" -> if (last) output += ""
            "..", ".%2e", "%2e.", "%2e%2e" -> {
                if (output.isNotEmpty()) output.removeAt(output.size - 1)
                if (last) output += ""
            }
            else -> output += segment
        }
    }
    return "/" + output.joinToString("/")
}

/**
 * Percent-encodes what the URL parser encodes in a path or query that a playlist is likely to
 * hold: spaces, controls and non-ASCII characters. Everything else, `[ ] |` included, stays.
 */
private fun encode(text: String): String {
    val result = StringBuilder()
    var index = 0
    while (index < text.length) {
        val codePoint = text.codePointAt(index)
        val width = Character.charCount(codePoint)
        if (codePoint in 0x21..0x7E && codePoint.toChar() !in "\"<>`{}") {
            result.append(codePoint.toChar())
        } else {
            for (byte in String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8)) {
                result.append('%').append("%02X".format(byte.toInt() and 0xFF))
            }
        }
        index += width
    }
    return result.toString()
}
