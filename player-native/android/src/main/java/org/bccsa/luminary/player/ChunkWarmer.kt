package org.bccsa.luminary.player

import java.io.IOException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import okhttp3.Call
import okhttp3.CacheControl
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** One run of segments sharing a chunk object, in media time: `ChunkBoundary` in `player-core`. */
data class ChunkBoundary(val url: String, val start: Double, val end: Double) {
    companion object {
        /**
         * From `warmChunks`' arguments, which the bridge checks only for shape. A boundary missing
         * a field is skipped: warming is advisory, and an incomplete schedule warms less.
         */
        fun schedules(json: JsonArray): List<List<ChunkBoundary>> = json.map { schedule ->
            (schedule as? JsonArray).orEmpty().mapNotNull { boundary ->
                val fields = boundary as? JsonObject ?: return@mapNotNull null
                val url = (fields["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val start = (fields["start"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
                val end = (fields["end"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
                if (url == null || start == null || end == null) null else ChunkBoundary(url, start, end)
            }
        }
    }
}

/** Requests `Range: bytes=0-<bytes - 1>` of a URL and discards the answer. */
fun interface WarmFetch {
    fun warm(url: String, bytes: Int)
}

/**
 * The bytes are discarded ciphertext, read to completion and dropped; every failure is swallowed.
 * Nothing is cached, so the request reaches the edge.
 */
class OkHttpWarmFetch(
    private val client: OkHttpClient,
    /** True when the viewer asked the system to save data: a warm that fetches bytes nobody plays then costs them. */
    private val dataSaverOn: () -> Boolean = { false },
) : WarmFetch {
    override fun warm(url: String, bytes: Int) {
        if (dataSaverOn()) return
        val request = try {
            Request.Builder().url(url).header("Range", "bytes=0-${bytes - 1}").cacheControl(CacheControl.FORCE_NETWORK).build()
        } catch (invalid: IllegalArgumentException) {
            return
        }
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        it.body?.source()?.skip(Long.MAX_VALUE)
                    } catch (ignored: IOException) {
                    }
                }
            }
        })
    }
}

/**
 * The chunk-warming loop, ported from `player-web/src/adapter/chunkWarming.ts` and following the
 * nine rules of `docs/chunk-warming.md`. It runs beside the engine, on the main looper's clock, so
 * it keeps warming while JavaScript is frozen.
 *
 * About once a second it reads the buffer front (`max(bufferedEnd, currentTime)`); when that is
 * within `leadSeconds` of the end of the run it is in, it asks for the first `warmBytes` of the next
 * chunk object, so the edge pulls it before the engine crosses into it. Each chunk is warmed at
 * most once, a chain's first never, and failures are swallowed. It stops itself once nothing is
 * left to warm. One warmer serves one load: [PlayerHost] makes a new one for each.
 */
class ChunkWarmer(
    private val clock: Clock,
    /** The buffer front, floored at the playhead; NaN when unknown. */
    private val watermark: () -> Double,
    private val fetch: WarmFetch,
) {
    /** Chunk URLs already asked for, across every arming of this warmer. */
    private val warmed = HashSet<String>()

    /** Chunk URLs the armed schedules could still warm. */
    private val unwarmed = HashSet<String>()
    private var schedules: List<List<ChunkBoundary>> = emptyList()
    private var leadSeconds = 60.0
    private var warmBytes = 65_536
    private var timer: Cancellable? = null

    /** Whether the loop is sampling; for tests. */
    val ticking: Boolean get() = timer != null

    /**
     * Arms the loop for these chains; an empty list stops it. It ticks while paused: a player
     * parked short of a boundary gets the next chunk warmed before play is pressed again.
     */
    fun start(schedules: List<List<ChunkBoundary>>, leadSeconds: Double, warmBytes: Int) {
        stop()
        this.schedules = schedules
        this.leadSeconds = leadSeconds
        this.warmBytes = maxOf(warmBytes, 1)
        unwarmed.clear()
        unwarmed += warmableUrls(schedules, warmed)
        if (unwarmed.isEmpty()) return
        schedule()
    }

    fun stop() {
        timer?.cancel()
        timer = null
        schedules = emptyList()
    }

    private fun schedule() {
        timer = clock.schedule(INTERVAL) { tick() }
    }

    private fun tick() {
        timer = null
        val front = watermark()
        if (front.isFinite()) {
            for (schedule in schedules) {
                val index = schedule.indexOfFirst { front >= it.start && front < it.end }
                if (index < 0) continue
                val current = schedule[index]
                if (current.end - front > leadSeconds || index + 1 >= schedule.size) continue
                val next = schedule[index + 1]
                // A run continuing in the same object needs nothing.
                if (next.url == current.url) continue
                warm(next.url)
            }
        }
        // That was the last one: nothing is left for this load.
        if (unwarmed.isEmpty()) {
            schedules = emptyList()
            return
        }
        schedule()
    }

    private fun warm(url: String) {
        // Marked before the request, and never retried: the engine's own request is the fallback.
        if (!warmed.add(url)) return
        unwarmed.remove(url)
        try {
            fetch.warm(url, warmBytes)
        } catch (ignored: Exception) {
            // Advisory in both directions: nothing about a warm may reach the viewer.
        }
    }

    private companion object {
        const val INTERVAL = 1.0

        /** Each boundary whose chunk differs from the one before it, a chain's first excepted. */
        fun warmableUrls(schedules: List<List<ChunkBoundary>>, excluding: Set<String>): Set<String> {
            val urls = HashSet<String>()
            for (schedule in schedules) {
                for (i in 1 until schedule.size) {
                    if (schedule[i].url != schedule[i - 1].url && schedule[i].url !in excluding) urls += schedule[i].url
                }
            }
            return urls
        }
    }
}
