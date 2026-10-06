package org.bccsa.luminary.player

import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/** Why a read of a live playlist failed, with the bridge's error codes. */
sealed class LiveFailure(val code: String, message: String) : Exception(message) {
    /** A non-2xx answer carrying its [status], or a transport failure carrying its [cause]. */
    class FetchFailed(val status: Int?, cause: Throwable? = null) :
        LiveFailure("fetch-failed", "fetch-failed${status?.let { ": HTTP $it" } ?: ""}") {
        init {
            cause?.let(::initCause)
        }
    }

    /** LMCENC with no key, or an AES-128 key with no key URI to point it at. */
    class KeyRequired : LiveFailure("key-required", "key-required")

    /** Decryption failed, or decrypted to something that is not a playlist: the wrong key. */
    class DecryptFailed : LiveFailure("decrypt-failed", "decrypt-failed")

    /** Neither LMCENC nor a playlist. */
    class InvalidContent : LiveFailure("invalid-content", "invalid-content")
}

/** One registered `luminary://live/<n>` address. The key is bytes, so [zero] can clear it. */
class LiveSpec(
    val url: String,
    val baseUrl: String,
    /** Absent when empty, as it is for the TypeScript original. */
    val keyUri: String?,
    private var key: ByteArray?,
    val refreshSec: Double,
) {
    val keyBytes: ByteArray? @Synchronized get() = key?.copyOf()

    @Synchronized
    fun zero() {
        key?.fill(0)
        key = null
    }

    companion object {
        fun of(spec: BridgeLiveSpec) = LiveSpec(
            spec.url,
            spec.baseUrl,
            spec.keyUri?.takeIf { it.isNotEmpty() },
            spec.keyHex?.let(::hexBytes),
            spec.refreshSec,
        )
    }
}

/** One read of a live playlist, which [cancel] can abandon from another thread. */
interface LiveRead {
    /** Blocks for the body, or throws [LiveFailure.FetchFailed]. */
    fun execute(): ByteArray

    fun cancel()
}

fun interface LiveFetch {
    fun start(url: String): LiveRead
}

/** How long one read of a live playlist may take, in seconds. */
const val LIVE_READ_TIMEOUT_SECONDS = 10L

/** Reads the playlist afresh, bypassing every cache: a cached read would freeze the window. */
class OkHttpLiveFetch(client: OkHttpClient) : LiveFetch {
    // One hung edge response must not stall the refresh: a target duration is a few seconds,
    // and the engine asks again.
    private val client = client.newBuilder().callTimeout(LIVE_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()

    override fun start(url: String): LiveRead {
        val call: Call = try {
            client.newCall(Request.Builder().url(url).cacheControl(CacheControl.FORCE_NETWORK).build())
        } catch (invalid: IllegalArgumentException) {
            return object : LiveRead {
                override fun execute(): ByteArray = throw LiveFailure.FetchFailed(null, invalid)

                override fun cancel() {}
            }
        }
        return object : LiveRead {
            override fun execute(): ByteArray = try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw LiveFailure.FetchFailed(response.code)
                    response.body?.bytes() ?: ByteArray(0)
                }
            } catch (failure: LiveFailure) {
                throw failure
            } catch (io: IOException) {
                throw LiveFailure.FetchFailed(null, io)
            }

            override fun cancel() = call.cancel()
        }
    }
}

/**
 * `luminary://live/<n>`, one read per engine request, ported from `resolveLivePlaylist`
 * (`player-core/src/policy/live.ts`): fetch, decrypt when LMCENC, refuse an AES-128 key with no
 * key URI, rewrite. No timer: ExoPlayer's own playlist refresh drives it, so it keeps a live stream
 * fresh while JavaScript is frozen.
 */
object LiveResolver {
    /** Reads [spec]'s playlist and resolves it, or throws a [LiveFailure]. */
    fun resolve(spec: LiveSpec, read: LiveRead): String = decode(read.execute(), spec)

    /** The steps after the fetch, in `resolveLivePlaylist`'s order. */
    fun decode(bytes: ByteArray, spec: LiveSpec): String {
        val text: String
        if (Lmcenc.isEncrypted(bytes)) {
            val key = spec.keyBytes ?: throw LiveFailure.KeyRequired()
            try {
                val plain = Lmcenc.decrypt(bytes, key)
                if (plain == null || !isPlaylist(plain)) throw LiveFailure.DecryptFailed()
                text = utf8(plain)
            } finally {
                key.fill(0)
            }
        } else {
            if (!isPlaylist(bytes)) throw LiveFailure.InvalidContent()
            text = utf8(bytes)
        }
        if (spec.keyUri == null && hasAes128Key(text)) throw LiveFailure.KeyRequired()
        return rewriteMediaPlaylist(text, spec.baseUrl, spec.keyUri)
    }

    private val BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
    private val EXTM3U = "#EXTM3U".toByteArray(Charsets.US_ASCII)

    private fun withoutBom(bytes: ByteArray): ByteArray =
        if (bytes.size >= BOM.size && bytes.copyOf(BOM.size).contentEquals(BOM)) bytes.copyOfRange(BOM.size, bytes.size) else bytes

    /** Starts with `#EXTM3U`, after an optional byte-order mark. */
    fun isPlaylist(bytes: ByteArray): Boolean {
        val body = withoutBom(bytes)
        return body.size >= EXTM3U.size && body.copyOf(EXTM3U.size).contentEquals(EXTM3U)
    }

    /** UTF-8 with a leading byte-order mark dropped, as `TextDecoder` does. */
    private fun utf8(bytes: ByteArray): String = String(withoutBom(bytes), Charsets.UTF_8)
}

/**
 * LMCENC (`docs/encrypted-sidecar-format.md`): `LMCENC01`, a 16-byte IV, then AES-128-CBC
 * ciphertext with PKCS#7 padding.
 */
object Lmcenc {
    private val MAGIC = "LMCENC01".toByteArray(Charsets.US_ASCII)
    private const val IV_LENGTH = 16

    fun isEncrypted(bytes: ByteArray): Boolean =
        bytes.size >= MAGIC.size + IV_LENGTH && bytes.copyOf(MAGIC.size).contentEquals(MAGIC)

    /** The plaintext, or null when the key is malformed or decryption fails. */
    fun decrypt(bytes: ByteArray, key: ByteArray): ByteArray? {
        if (!isEncrypted(bytes) || key.size != 16) return null
        return try {
            val iv = bytes.copyOfRange(MAGIC.size, MAGIC.size + IV_LENGTH)
            val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            cipher.doFinal(bytes, MAGIC.size + IV_LENGTH, bytes.size - MAGIC.size - IV_LENGTH)
        } catch (failure: java.security.GeneralSecurityException) {
            null
        }
    }
}

/** Hex pairs to bytes; `bridge.ts` guarantees 32 ASCII hex characters before this is reached. */
internal fun hexBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
