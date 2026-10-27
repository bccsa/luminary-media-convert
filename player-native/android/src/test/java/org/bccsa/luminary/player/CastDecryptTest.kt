package org.bccsa.luminary.player

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CastDecryptTest {
    private val playlist = """
        #EXTM3U
        #EXT-X-MAP:URI="https://cdn.example.com/init.mp4"
        #EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x0f0e0d0c0b0a09080706050403020100
        #EXTINF:1.0,
        #EXT-X-BYTERANGE:5664@0
        https://cdn.example.com/media/v_0.m4s
        #EXTINF:1.0,
        #EXT-X-BYTERANGE:5040@5664
        https://cdn.example.com/media/v_0.m4s
        #EXT-X-ENDLIST
    """.trimIndent() + "\n"

    @Test
    fun `an encrypted playlist loses its key and byte ranges, and each segment gets a plain address`() {
        val seen = ArrayList<CastSegment>()
        val plain = decryptedForCast(playlist) { segment -> seen += segment; "http://phone/d/${seen.size}" }
        assertEquals(
            "#EXTM3U\n#EXT-X-MAP:URI=\"http://phone/d/1\"\n#EXTINF:1.0,\nhttp://phone/d/2\n#EXTINF:1.0,\nhttp://phone/d/3\n#EXT-X-ENDLIST\n",
            plain,
        )
        // The init segment is plain, so it has no IV.
        assertNull(seen[0].iv)
        assertEquals(listOf(null to null, 0L to 5664L, 5664L to 5040L), seen.map { it.offset to it.length })
        assertEquals("0f0e0d0c0b0a09080706050403020100", seen[1].iv!!.joinToString("") { "%02x".format(it) })
    }

    @Test
    fun `a playlist with no key of the bridge's is left as it was`() {
        val clear = "#EXTM3U\n#EXTINF:1.0,\nhttps://cdn.example.com/a.m4s\n"
        assertEquals(clear, decryptedForCast(clear) { error("no segment is encrypted") })
    }

    @Test
    fun `without an IV the sequence number is the IV`() {
        val text = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI=\"luminary://key\"\n#EXTINF:1,\nhttps://x/a.m4s\n"
        var iv = ByteArray(0)
        decryptedForCast(text) { iv = it.iv!!; "p" }
        assertEquals(5, iv[15].toInt())
        assertEquals(16, iv.size)
    }

    @Test
    fun `a segment decrypts under its key and IV, and fails under another`() {
        val key = ByteArray(16) { it.toByte() }
        val iv = ByteArray(16) { (16 - it).toByte() }
        val data = ByteArray(1000) { (it * 7).toByte() }
        val sealed = Cipher.getInstance("AES/CBC/PKCS5Padding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            doFinal(data)
        }
        assertArrayEquals(data, decryptSegment(sealed, key, iv))
        assertNull(decryptSegment(sealed, ByteArray(15), iv))
    }
}
