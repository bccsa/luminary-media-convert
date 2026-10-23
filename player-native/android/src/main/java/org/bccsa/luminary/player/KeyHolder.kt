package org.bccsa.luminary.player

/** The current 16-byte key. Zeroed on destroy or replace, and never logged. */
class KeyHolder {
    private var key: ByteArray? = null

    /** Replaces the key; the old bytes are zeroed first, and no hex, or hex that does not decode, means no key. */
    @Synchronized
    fun set(hex: String?) {
        zero()
        if (hex != null && hex.length % 2 == 0 && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            key = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        }
    }

    /** A copy, so a reader holding it cannot see the zeroing or keep the original alive. */
    @Synchronized
    fun copy(): ByteArray? = key?.copyOf()

    @Synchronized
    fun zero() {
        key?.fill(0)
        key = null
    }
}
