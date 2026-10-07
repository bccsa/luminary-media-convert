package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The engine's only outbound path. Stamps every event with its player and load, and enforces the
 * emission rules in `conformance/README.md` on [clock]. An engine reports what happened; whether
 * and when that becomes an event is decided here, the same way on every engine.
 */
class EventSink(
    private val playerId: String,
    private val clock: Clock,
    private val variantSwitching: Boolean,
    private val emit: (name: String, payload: JsonObject) -> Unit,
    /** The playhead, read when a periodic `timeupdate` fires. */
    private val position: () -> Double,
) {
    private var loadId: String? = null
    private var silent = false
    private var duration: Double? = 0.0
    /** A new player plays at 1; a load keeps whatever rate the last one had. */
    private var rate = 1.0
    private var tick: Cancellable? = null
    private var lastProgressAt: Double? = null
    private var heldProgress: Double? = null
    private var heldProgressTimer: Cancellable? = null

    /** A new load: what follows is stamped with it, and nothing of the last carries over. */
    fun begin(loadId: String) {
        this.loadId = loadId
        duration = 0.0
        stopTicking()
        heldProgressTimer?.cancel()
        heldProgressTimer = null
        lastProgressAt = null
        heldProgress = null
    }

    /** Nothing is emitted after this, whatever the engine still reports. */
    fun close() {
        silent = true
        stopTicking()
        heldProgressTimer?.cancel()
        heldProgressTimer = null
    }

    private fun send(name: String, payload: JsonObject = JsonObject(emptyMap())) {
        // Before the first load there is no load to stamp an event with.
        val loadId = loadId ?: return
        if (silent) return
        emit(name, JsonObject(payload + buildJsonObject {
            put("playerId", playerId)
            put("loadId", loadId)
        }))
    }

    // What the engine reports.

    /** The item is ready: `durationchange` if it changed, then `loadedmetadata`. */
    fun readyToPlay(reported: Double?) {
        durationChanged(reported)
        send("loadedmetadata", buildJsonObject { put("duration", duration) })
    }

    /**
     * Null while unbounded (live). In whole milliseconds: an engine refines the duration as it
     * loads, and the sub-millisecond part tells the host nothing.
     */
    fun durationChanged(reported: Double?) {
        val duration = reported?.let { Math.round(it * 1000) / 1000.0 }
        if (duration == this.duration) return
        this.duration = duration
        send("durationchange", buildJsonObject { put("duration", duration) })
    }

    fun playing() {
        send("playing")
        startTicking()
    }

    fun paused() {
        stopTicking()
        timeupdateNow()
        send("pause")
    }

    fun buffering() = send("waiting")

    fun seeked() {
        timeupdateNow()
        send("seeked")
    }

    fun ended() {
        stopTicking()
        send("ended")
    }

    fun audioTracks(tracks: List<AudioTrack>, activeId: String?) = send(
        "audiotracks-updated",
        buildJsonObject {
            put("tracks", tracks.toJson())
            put("activeId", activeId)
        },
    )

    /** Always empty unless `variantSwitching`, so there is nothing to announce. */
    fun variants(variants: List<Variant>) {
        if (variantSwitching) send("variants-updated", buildJsonObject { put("variants", variants.toJson()) })
    }

    /** The end of the buffered range containing the playhead; at most one `progress` a second. */
    fun bufferedTo(end: Double) {
        val now = clock.now()
        val last = lastProgressAt
        if (last == null || now - last >= PROGRESS_PERIOD) {
            lastProgressAt = now
            send("progress", buildJsonObject { put("bufferedEnd", end) })
            return
        }
        // Held: the latest value goes out when the window ends.
        heldProgress = end
        if (heldProgressTimer == null) {
            heldProgressTimer = clock.schedule(last + PROGRESS_PERIOD - now) {
                heldProgressTimer = null
                lastProgressAt = clock.now()
                heldProgress?.let { send("progress", buildJsonObject { put("bufferedEnd", it) }) }
                heldProgress = null
            }
        }
    }

    private var airPlay = false to false

    /**
     * Only on a change: another device appeared or went (`available`), or playback went to one or
     * came back (`active`). The devices around are the player's, not a load's, so this is sent
     * before the first load too: the SDK often knows long before a source does.
     */
    fun airPlayChanged(available: Boolean, active: Boolean) {
        if (airPlay == available to active) return
        airPlay = available to active
        if (silent) return
        emit(
            "airplaychange",
            JsonObject(
                buildJsonObject {
                    put("available", available)
                    put("active", active)
                    put("playerId", playerId)
                    loadId?.let { put("loadId", it) }
                },
            ),
        )
    }

    /** The viewer picked an angle or a quality in the TV's menu; the page applies it as its own pick. */
    fun castSelect(kind: String, id: String) {
        send(
            "castselect",
            buildJsonObject {
                put("kind", kind)
                put("id", id)
            },
        )
    }

    private var muted = false

    /** Only on a change, whoever made it: a `setMuted`, or the viewer in native UI. */
    fun mutedChanged(muted: Boolean) {
        if (muted == this.muted) return
        this.muted = muted
        send("mutedchange", buildJsonObject { put("muted", muted) })
    }

    /** Only on a change, whoever made it: a `setRate`, or the viewer in native UI. */
    fun rateChanged(rate: Double) {
        if (rate == this.rate) return
        this.rate = rate
        send("ratechange", buildJsonObject { put("rate", rate) })
    }

    /** Only on the engine's own verdict, never from a timer. */
    fun stalled(stalled: Boolean) = send("stalled", buildJsonObject { put("stalled", stalled) })

    fun error(category: String, fatal: Boolean, code: String, message: String) = send(
        "error",
        buildJsonObject {
            put("category", category)
            put("fatal", fatal)
            put("code", code)
            put("message", message)
        },
    )

    /** The engine needs the munged source rebuilt: the one repair it cannot make itself. */
    fun reloadRequested(reason: String, attempt: Int) = send(
        "reload-requested",
        buildJsonObject {
            put("reason", reason)
            put("attempt", attempt)
        },
    )

    /** `inline` means not presented. */
    fun presentationChanged(state: String) = send("presentationchange", buildJsonObject { put("state", state) })

    // The 4 Hz `timeupdate`.

    /** The 0.25 s period starts now; there is no `timeupdate` at the transition itself. */
    private fun startTicking() {
        stopTicking()
        tick = clock.schedule(TIMEUPDATE_PERIOD, ::onTick)
    }

    private fun stopTicking() {
        tick?.cancel()
        tick = null
    }

    private fun onTick() {
        send("timeupdate", buildJsonObject { put("currentTime", position()) })
        tick = clock.schedule(TIMEUPDATE_PERIOD, ::onTick)
    }

    /** A `timeupdate` outside the period (seek, pause); a running period restarts from it. */
    private fun timeupdateNow() {
        send("timeupdate", buildJsonObject { put("currentTime", position()) })
        if (tick != null) startTicking()
    }

    private companion object {
        const val TIMEUPDATE_PERIOD = 0.25
        const val PROGRESS_PERIOD = 1.0
    }
}
