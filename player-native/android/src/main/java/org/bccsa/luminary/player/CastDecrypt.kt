package org.bccsa.luminary.player

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** One segment of a media playlist: where it is, the part of it that is the segment, and its IV (none: it is plain). */
class CastSegment(val url: String, val offset: Long?, val length: Long?, val iv: ByteArray?)

private val KEY_TAG = "#EXT-X-KEY:"
private val MAP_TAG = "#EXT-X-MAP:"
private val MAP_URI = Regex("URI=\"([^\"]*)\"")
private val MAP_BYTERANGE = Regex(",?BYTERANGE=\"(\\d+)@(\\d+)\"")
private val BYTERANGE_TAG = "#EXT-X-BYTERANGE:"
private val SEQUENCE_TAG = "#EXT-X-MEDIA-SEQUENCE:"
private val METHOD = Regex("METHOD=([A-Z0-9-]+)")
private val KEY_URI_ATTRIBUTE = Regex("URI=\"([^\"]*)\"")
private val IV_ATTRIBUTE = Regex("IV=0[xX]([0-9a-fA-F]+)")

/**
 * [text] with the bridge's own AES-128 segments made plain: the key line goes, each encrypted segment's
 * address becomes whatever [address] returns for it, and its byte range goes with it, since the
 * decrypted segment is served whole. A receiver that cannot play encrypted fragmented MP4 gets plain.
 * Anything else, a playlist with no such key included, comes back as it was.
 */
fun decryptedForCast(text: String, address: (CastSegment) -> String): String {
    if (!text.contains("METHOD=AES-128") || !text.contains("URI=\"$KEY_URI\"")) return text
    val lines = text.split("\n")
    val sequenceStart = lines.firstNotNullOfOrNull {
        it.trimEnd('\r').takeIf { line -> line.startsWith(SEQUENCE_TAG) }?.removePrefix(SEQUENCE_TAG)?.trim()?.toLongOrNull()
    } ?: 0L
    val out = ArrayList<String>(lines.size)
    var keyIv: ByteArray? = null
    var keyed = false
    var range: Pair<Long, Long?>? = null
    var index = 0L
    for (line in lines) {
        val bare = line.trimEnd('\r')
        when {
            bare.startsWith(KEY_TAG) -> {
                val method = METHOD.find(bare)?.groupValues?.get(1)
                val uri = KEY_URI_ATTRIBUTE.find(bare)?.groupValues?.get(1)
                if (method == "AES-128" && uri == KEY_URI) {
                    keyed = true
                    keyIv = IV_ATTRIBUTE.find(bare)?.groupValues?.get(1)?.let(::ivOf)
                } else {
                    keyed = false
                    out += line
                }
            }
            bare.startsWith(MAP_TAG) -> {
                // The init segment is plain, but the receiver reads it from here too, where the CORS headers are.
                val uri = MAP_URI.find(bare)?.groupValues?.get(1)
                val range = MAP_BYTERANGE.find(bare)
                if (uri == null) {
                    out += line
                } else {
                    val offset = range?.groupValues?.get(2)?.toLongOrNull()
                    val length = range?.groupValues?.get(1)?.toLongOrNull()
                    val address = address(CastSegment(uri, offset, length, null))
                    out += bare.replace(MAP_BYTERANGE, "").replace(MAP_URI, "URI=\"$address\"")
                }
            }
            bare.startsWith(BYTERANGE_TAG) && keyed -> {
                val spec = bare.removePrefix(BYTERANGE_TAG).trim()
                val length = spec.substringBefore('@').toLongOrNull()
                val offset = spec.substringAfter('@', "").toLongOrNull()
                range = if (length != null && offset != null) offset to length else null
            }
            bare.isNotEmpty() && !bare.startsWith("#") && keyed -> {
                val iv = keyIv ?: sequenceIv(sequenceStart + index)
                out += address(CastSegment(bare, range?.first, range?.second, iv))
                range = null
                index++
            }
            bare.isNotEmpty() && !bare.startsWith("#") -> {
                index++
                out += line
            }
            else -> out += line
        }
    }
    return out.joinToString("\n")
}

private fun ivOf(hex: String): ByteArray {
    val padded = hex.padStart(32, '0').takeLast(32)
    return ByteArray(16) { padded.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/** The IV a playlist with none names: the segment's sequence number, big-endian in 16 bytes. */
private fun sequenceIv(sequence: Long) = ByteArray(16).also { iv ->
    for (i in 0 until 8) iv[15 - i] = (sequence ushr (8 * i)).toByte()
}

/** AES-128-CBC with PKCS#7 padding; null when the key or the bytes do not fit. */
fun decryptSegment(bytes: ByteArray, key: ByteArray, iv: ByteArray): ByteArray? {
    if (key.size != 16 || iv.size != 16) return null
    return try {
        Cipher.getInstance("AES/CBC/PKCS5Padding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            doFinal(bytes)
        }
    } catch (failure: java.security.GeneralSecurityException) {
        null
    }
}
