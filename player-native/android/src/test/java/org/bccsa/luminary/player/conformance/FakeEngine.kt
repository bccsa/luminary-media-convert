package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.bccsa.luminary.player.AudioTrack
import org.bccsa.luminary.player.Clock
import org.bccsa.luminary.player.Engine
import org.bccsa.luminary.player.EventSink
import org.bccsa.luminary.player.Snapshot
import org.bccsa.luminary.player.Variant

/**
 * The `FakeEngine` of `conformance/README.md`, the same on iOS. A command only records itself;
 * nothing changes until a signal says so.
 */
class FakeEngine(
    private val clock: Clock,
    /** Shared by every engine a harness creates, so the harness drains one list. */
    private val log: MutableList<JsonObject>,
) : Engine {
    override lateinit var events: EventSink
    override var hasVideo = true
        private set
    private var basePosition = 0.0
    private var baseTime = 0.0
    private var rate = 1.0
    private var playing = false
    private var duration: Double? = 0.0
    private var bufferedEnd = 0.0

    // Commands: recorded, never acted on.

    override fun load(masterUri: String, startPosition: Double?) {
        record("load") {
            put("masterUri", masterUri)
            if (startPosition != null) put("startPosition", startPosition)
        }
        playing = false
        setPosition(startPosition ?: 0.0)
        duration = 0.0
        bufferedEnd = 0.0
        hasVideo = true
    }

    override fun reattach() = record("reattach")
    override fun play() = record("play")
    override fun pause() = record("pause")
    override fun seek(position: Double, exact: Boolean) = record("seek") {
        put("position", position)
        put("exact", exact)
    }
    override fun setRate(rate: Double) = record("setRate") { put("rate", rate) }
    override fun setVariant(id: String) = record("setVariant") { put("id", id) }
    override fun setAudioTrack(id: String) = record("setAudioTrack") { put("id", id) }
    override fun enterFullscreen() = record("enterFullscreen")
    override fun exitFullscreen() = record("exitFullscreen")
    override fun destroy() = record("destroy")

    override fun snapshot() = Snapshot(position(), duration, bufferedEnd, playing)

    private fun position(): Double =
        if (playing) basePosition + (clock.now() - baseTime) * rate else basePosition

    // Signals: the engine's side of the story.

    fun signal(signal: String, args: JsonObject) {
        when (signal) {
            "readyToPlay" -> {
                duration = when (val value = args["duration"]) {
                    null -> 0.0
                    is JsonNull -> null
                    else -> value.number()
                }
                hasVideo = (args["hasVideo"] as? JsonPrimitive)?.content != "false"
                events.readyToPlay(duration)
            }
            "playing" -> {
                setPosition(position())
                playing = true
                events.playing()
            }
            "paused" -> {
                setPosition(position())
                playing = false
                events.paused()
            }
            "buffering" -> events.buffering()
            "seeked" -> {
                setPosition(args.getValue("position").number())
                events.seeked()
            }
            "ended" -> {
                setPosition(position())
                playing = false
                events.ended()
            }
            "tracks" -> events.audioTracks(
                (args["tracks"] as? JsonArray ?: JsonArray(emptyList())).map { track ->
                    track as JsonObject
                    AudioTrack(track.string("id")!!, track.string("lang"), track.string("label")!!)
                },
                args.string("activeId"),
            )
            "variants" -> events.variants(
                (args["variants"] as? JsonArray ?: JsonArray(emptyList())).map { variant ->
                    variant as JsonObject
                    Variant(
                        variant.string("id")!!,
                        (variant["height"] as? JsonPrimitive)?.intOrNull,
                        (variant.getValue("bandwidth") as JsonPrimitive).longOrNull!!,
                    )
                },
            )
            "bufferedTo" -> {
                bufferedEnd = args.getValue("end").number()
                events.bufferedTo(bufferedEnd)
            }
            "position" -> setPosition(args.getValue("position").number())
            "failed" -> error("failed: the recovery ladder arrives in phase 3")
            else -> error("Unknown engine signal $signal")
        }
    }

    private fun setPosition(position: Double) {
        basePosition = position
        baseTime = clock.now()
    }

    private fun record(method: String, args: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) {
        log += buildJsonObject {
            put("method", method)
            args()
        }
    }
}

private fun JsonElement.number(): Double = (this as JsonPrimitive).doubleOrNull!!

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
