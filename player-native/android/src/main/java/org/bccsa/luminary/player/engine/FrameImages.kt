package org.bccsa.luminary.player.engine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * The pictures of the up-next frames and rows: an address, a `data:` URL, or a path of the app's own files (the
 * stand-in pictures it ships, which the packaged app keeps under `public/`); fetched off the main thread, shrunk to the width they are drawn at,
 * and kept for the next time a list opens. A picture that does not load says why in the log; the frame keeps its
 * plain tile and still names the video.
 */
internal object FrameImages {
    private const val TAG = "LmcFrameImages"
    private const val TIMEOUT_MS = 10_000
    private const val MAX_BYTES = 8 * 1024 * 1024

    private val pool = Executors.newFixedThreadPool(3) { Thread(it, "lmc-frame-images").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<String, Bitmap>(24) {}

    /** Calls [done] on the main thread with the picture at [url], or null when it cannot be had. */
    fun load(context: Context, url: String, targetWidth: Int, done: (Bitmap?) -> Unit) {
        val key = "$targetWidth|$url"
        cache.get(key)?.let { return done(it) }
        pool.execute {
            val bitmap = runCatching { fetch(context.applicationContext, url, targetWidth) }
                .onFailure { Log.w(TAG, "No picture from $url: ${it.message}") }
                .getOrNull()
            if (bitmap != null) cache.put(key, bitmap)
            main.post { done(bitmap) }
        }
    }

    private fun fetch(context: Context, url: String, targetWidth: Int): Bitmap? {
        val bytes = ArtworkBitmapLoader.dataUrlBytes(url) ?: if (isAppPath(url)) appFile(context, url) else download(url)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) error("not a picture the device can read")
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= targetWidth) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** `/assets/x.webp`: a path on the app's own origin, not an address the device can fetch. */
    internal fun isAppPath(url: String) = url.startsWith("/") && !url.startsWith("//")

    /** The packaged app serves its pages from `public/`, so a path on its origin is a file there. */
    private fun appFile(context: Context, path: String): ByteArray =
        context.assets.open("public$path").use { it.readBytes() }

    private fun download(url: String): ByteArray {
        if (!url.startsWith("https://", ignoreCase = true) && !url.startsWith("http://", ignoreCase = true)) {
            error("not an address the player can fetch")
        }
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        try {
            if (connection.responseCode !in 200..299) error("answered ${connection.responseCode}")
            val out = java.io.ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    if (out.size() > MAX_BYTES) error("larger than a picture should be")
                }
            }
            return out.toByteArray()
        } finally {
            connection.disconnect()
        }
    }
}
