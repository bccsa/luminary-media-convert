package org.bccsa.luminary.spike

import android.content.Context
import java.io.FileNotFoundException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.bccsa.luminary.player.BridgeAsset

/** What `make-payload.mjs --android` wrote: the `load` arguments the TypeScript half sends, one visit per angle. */
class Payload(
    val masterUrl: String,
    val keyHex: String?,
    private val angles: Map<String, String>,
    val visits: List<Visit>,
    /** The bytes read from the asset, for the size log. */
    val bytes: Int,
) {
    class Visit(val angleId: String, val masterUri: String, val generation: Int, val assets: List<BridgeAsset>) {
        val audioOnly get() = angleId == AUDIO_ONLY_ANGLE_ID
    }

    fun name(visit: Visit): String =
        angles[visit.angleId] ?: if (visit.audioOnly) "Audio only" else visit.angleId

    companion object {
        /** `AUDIO_ONLY_ANGLE_ID` in `player-core`. */
        const val AUDIO_ONLY_ANGLE_ID = "__audio__"

        /** Null when `payload.json` is not in the app's assets. */
        fun bundled(context: Context): Payload? {
            val text = try {
                context.assets.open("payload.json").use { String(it.readBytes(), Charsets.UTF_8) }
            } catch (_: FileNotFoundException) {
                return null
            }
            val json = Json.parseToJsonElement(text).jsonObject
            fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
            return Payload(
                masterUrl = json.string("masterUrl"),
                keyHex = json["keyHex"].takeUnless { it == null || it is JsonNull }?.jsonPrimitive?.content,
                angles = json.getValue("angles").jsonArray.associate {
                    it.jsonObject.string("id") to it.jsonObject.string("name")
                },
                visits = json.getValue("visits").jsonArray.map { element ->
                    val visit = element.jsonObject
                    Visit(
                        angleId = visit.string("angleId"),
                        masterUri = visit.string("masterUri"),
                        generation = visit.getValue("generation").jsonPrimitive.int,
                        assets = visit.getValue("assets").jsonArray.map {
                            val asset = it.jsonObject
                            BridgeAsset(asset.string("uri"), asset.string("contentType"), asset.string("text"))
                        },
                    )
                },
                bytes = text.toByteArray().size,
            )
        }
    }
}
