package org.bccsa.luminary.player

/*
 * What a Cast receiver is given in place of the bridge's own addresses. The receiver fetches the
 * stream itself and cannot reach `luminary://`, so while casting the phone answers for those
 * addresses over HTTP (`CastServer`), and the text it serves names them by their HTTP form.
 *
 *   luminary://asset/<generation>/<name>  →  <base>/a/<generation>/<name>
 *   luminary://key                        →  <base>/key
 *   luminary://live/<n>                   →  <base>/l/<n>.m3u8
 *
 * `<base>` is `http://<phone>:<port>/<token>`. Segment and init URLs are already absolute
 * `https://` after the munge and are left alone.
 */

private val ASSET = Regex("luminary://asset/")
private val KEY = Regex("luminary://key(?![A-Za-z0-9_])")
private val LIVE = Regex("luminary://live/(\\d+)")

/** [text] with every bridge address replaced by the HTTP address the phone serves it at. */
fun rewriteForCast(text: String, base: String): String =
    text
        .replace(ASSET, "$base/a/")
        .replace(KEY, "$base/key")
        .replace(LIVE) { "$base/l/${it.groupValues[1]}.m3u8" }

/** The bridge address a request path under the token stands for, or null for a path that is none. */
fun bridgeUriOf(path: String): String? {
    if (path == "/key") return KEY_URI
    ASSET_PATH.matchEntire(path)?.let { return "${ASSET_URI_PREFIX}${it.groupValues[1]}/${it.groupValues[2]}" }
    LIVE_PATH.matchEntire(path)?.let { return "${LIVE_URI_PREFIX}${it.groupValues[1]}" }
    return null
}

private val ASSET_PATH = Regex("/a/(\\d+)/([A-Za-z0-9._-]+)")
private val LIVE_PATH = Regex("/l/(\\d+)\\.m3u8")
