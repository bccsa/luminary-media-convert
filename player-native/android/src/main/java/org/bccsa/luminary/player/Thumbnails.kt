package org.bccsa.luminary.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** One frame of the scrub roster: the crop of a sprite sheet that covers `start` until `end`. */
data class ThumbnailCue(val start: Double, val end: Double, val url: String, val x: Int, val y: Int, val w: Int, val h: Int)

/**
 * `thumbnails.vtt` as the encoder writes it: WebVTT whose payload is a sprite sheet and an `#xywh=` crop.
 * A port of `parseThumbnailVtt` and `findThumbnailCue` (`hls-core/src/thumbnail-vtt.ts`), which the web
 * player's preview uses; the two have to read the same file the same way.
 */
object ThumbnailVtt {
    fun parseTime(text: String): Double {
        val parts = text.trim().split(':')
        if (parts.size != 3) return 0.0
        val seconds = parts[2].split('.')
        val ms = seconds.getOrNull(1)?.padEnd(3, '0')?.toIntOrNull() ?: 0
        return (parts[0].toIntOrNull() ?: 0) * 3600.0 + (parts[1].toIntOrNull() ?: 0) * 60.0 + (seconds[0].toIntOrNull() ?: 0) + ms / 1000.0
    }

    /** The cues of [text], with sprite paths resolved against [baseUrl], the directory of the VTT. */
    fun parse(text: String, baseUrl: String): List<ThumbnailCue> {
        val cues = ArrayList<ThumbnailCue>()
        for (block in text.replace("\r\n", "\n").replace('\r', '\n').split(Regex("\n\n+"))) {
            val lines = block.trim().split('\n')
            val timeIndex = lines.indexOfFirst { " --> " in it }
            if (timeIndex < 0) continue
            val (startText, endText) = lines[timeIndex].split(" --> ").let { it[0] to it.getOrElse(1) { "" } }
            val payload = lines.getOrNull(timeIndex + 1)?.trim()?.takeIf { it.isNotEmpty() } ?: continue
            val fileRef = payload.substringBefore('#')
            val fragment = payload.substringAfter('#', "")
            val url = if (fileRef.startsWith("http")) fileRef else "$baseUrl/$fileRef"
            var x = 0
            var y = 0
            var w = 0
            var h = 0
            if (fragment.startsWith("xywh=")) {
                val values = fragment.removePrefix("xywh=").split(',').map { it.trim().toDoubleOrNull()?.toInt() ?: 0 }
                x = values.getOrElse(0) { 0 }
                y = values.getOrElse(1) { 0 }
                w = values.getOrElse(2) { 0 }
                h = values.getOrElse(3) { 0 }
            }
            cues += ThumbnailCue(parseTime(startText), parseTime(endText), url, x, y, w, h)
        }
        return cues
    }

    /** The cue covering [time], or null; binary search, because a scrub asks on every move. */
    fun find(cues: List<ThumbnailCue>, time: Double): ThumbnailCue? {
        var lo = 0
        var hi = cues.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            val cue = cues[mid]
            when {
                time < cue.start -> hi = mid - 1
                time >= cue.end -> lo = mid + 1
                else -> return cue
            }
        }
        return null
    }
}

/**
 * The frames the full-screen controls draw under a held timeline. Fetched by native, not sent by
 * JavaScript, so the roster works while JavaScript is frozen: the VTT is read (and decrypted when it
 * is LMCENC, with the load's key), and the sprite sheets are fetched the first time a frame on them is
 * wanted. Every failure leaves no frames, which is what a source without any looks like.
 */
class Thumbnails(private val read: (String) -> ByteArray? = ::fetch) {
    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newFixedThreadPool(3)
    private val sheets = object : LruCache<String, Bitmap>(SHEET_CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val asked = HashSet<String>()

    @Volatile
    private var cues: List<ThumbnailCue> = emptyList()

    /** Bumped on every load, so a read that finishes for an earlier one is discarded. */
    @Volatile
    private var generation = 0

    /** Called on the main thread when the VTT has arrived or a sheet has, so a view can draw again. */
    var onChange: (() -> Unit)? = null

    val ready: Boolean get() = cues.isNotEmpty()

    /** Starts reading [url] (null: no frames). [key] is the LMCENC key, which is zeroed after use. */
    fun load(url: String?, key: ByteArray?) {
        val mine = ++generation
        cues = emptyList()
        synchronized(asked) { asked.clear() }
        sheets.evictAll()
        main.post { onChange?.invoke() }
        if (url == null) {
            key?.fill(0)
            return
        }
        work.execute {
            val parsed = try {
                val bytes = read(url)
                val plain = when {
                    bytes == null -> null
                    Lmcenc.isEncrypted(bytes) -> key?.let { Lmcenc.decrypt(bytes, it) }
                    else -> bytes
                }
                plain?.let { ThumbnailVtt.parse(String(it, Charsets.UTF_8).removePrefix("﻿"), url.substringBeforeLast('/')) }.orEmpty()
            } catch (_: Exception) {
                emptyList()
            } finally {
                key?.fill(0)
            }
            if (mine != generation) return@execute
            cues = parsed
            main.post { if (mine == generation) onChange?.invoke() }
        }
    }

    fun cueAt(time: Double): ThumbnailCue? = ThumbnailVtt.find(cues, time)

    /** The first frame's crop shape, which every frame of an encode shares; null until there are frames. */
    fun sample(): ThumbnailCue? = cues.firstOrNull { it.w > 0 && it.h > 0 }

    /** The sheet [cue] is on if it is in memory; otherwise null, and the fetch starts. */
    fun sheet(cue: ThumbnailCue): Bitmap? {
        sheets.get(cue.url)?.let { return it }
        val mine = generation
        val start = synchronized(asked) { asked.add(cue.url) }
        if (start) {
            work.execute {
                val bitmap = runCatching { read(cue.url)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
                if (mine != generation) return@execute
                if (bitmap != null) {
                    sheets.put(cue.url, bitmap)
                    main.post { if (mine == generation) onChange?.invoke() }
                } else {
                    // Another try on the next ask, not a permanent hole.
                    synchronized(asked) { asked.remove(cue.url) }
                }
            }
        }
        return null
    }

    fun release() {
        generation++
        cues = emptyList()
        sheets.evictAll()
        work.shutdownNow()
    }

    companion object {
        private const val SHEET_CACHE_BYTES = 24 * 1024 * 1024

        /** A plain GET; null on anything but a 200. */
        fun fetch(url: String): ByteArray? {
            val connection = URL(url).openConnection() as HttpURLConnection
            return try {
                connection.connectTimeout = 10_000
                connection.readTimeout = 15_000
                if (connection.responseCode == 200) connection.inputStream.use { it.readBytes() } else null
            } finally {
                connection.disconnect()
            }
        }
    }
}

/**
 * Where the roster's frames sit: a Kotlin port of `rosterStep` / `rosterTiles` in
 * `player-web/src/ui/scrubPreview.ts`, so the strip slides the same way on both.
 */
object Roster {
    data class Tile(val index: Int, val left: Float, val time: Double)

    fun step(duration: Double): Double = (duration / 120).coerceIn(1.0, 15.0)

    fun tiles(time: Double, markerX: Float, width: Float, tileWidth: Float, step: Double, duration: Double): List<Tile> {
        if (!(width > 0) || !(tileWidth > 0) || !(step > 0) || !(duration > 0)) return emptyList()
        val perSecond = tileWidth / step
        val first = Math.floor((time - markerX / perSecond) / step).toInt()
        val last = Math.ceil((time + (width - markerX) / perSecond) / step).toInt()
        val tiles = ArrayList<Tile>()
        for (index in first..last) {
            val start = index * step
            if (start >= duration || start + step <= 0) continue
            tiles += Tile(
                index,
                (markerX + (start - time) * perSecond).toFloat(),
                (start + step / 2).coerceAtLeast(0.0).coerceAtMost((duration - 0.001).coerceAtLeast(0.0)),
            )
        }
        return tiles
    }
}
