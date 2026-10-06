package org.bccsa.luminary.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CastRewriteTest {
    private val base = "http://192.168.1.20:41234/0123abcd"

    @Test
    fun `every bridge address becomes the address the phone serves it at`() {
        val master = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"luminary://asset/1/2.m3u8\"\nluminary://asset/1/1.m3u8\n"
        assertEquals(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"$base/a/1/2.m3u8\"\n$base/a/1/1.m3u8\n",
            rewriteForCast(master, base),
        )
    }

    @Test
    fun `the key and a live address are rewritten, and a live address gets the extension a receiver reads a playlist by`() {
        val text = "#EXT-X-KEY:METHOD=AES-128,URI=\"luminary://key\",IV=0x01\nluminary://live/3\n"
        assertEquals("#EXT-X-KEY:METHOD=AES-128,URI=\"$base/key\",IV=0x01\n$base/l/3.m3u8\n", rewriteForCast(text, base))
    }

    @Test
    fun `segments and other addresses are left alone, and so are line endings`() {
        val text = "#EXTM3U\r\n#EXTINF:4,\r\nhttps://cdn.example.com/media/a_0.m4s\r\n#EXT-X-MAP:URI=\"https://cdn.example.com/init.mp4\"\r\n"
        assertEquals(text, rewriteForCast(text, base))
    }

    @Test
    fun `a key address is not matched inside a longer name`() {
        assertEquals("luminary://keyboard", rewriteForCast("luminary://keyboard", base))
    }

    @Test
    fun `an address maps back to the bridge address it stands for, and anything else maps to none`() {
        assertEquals("luminary://asset/1/2.m3u8", bridgeUriOf("/a/1/2.m3u8"))
        assertEquals("luminary://asset/12/subs_en.vtt", bridgeUriOf("/a/12/subs_en.vtt"))
        assertEquals("luminary://key", bridgeUriOf("/key"))
        assertEquals("luminary://live/3", bridgeUriOf("/l/3.m3u8"))
        for (bad in listOf("", "/", "/a/1", "/a/x/2.m3u8", "/a/1/../2.m3u8", "/a/1/2/3.m3u8", "/key/x", "/l/3", "/l/x.m3u8", "//a/1/2.m3u8")) {
            assertNull("$bad is not an address", bridgeUriOf(bad))
        }
    }

    @Test
    fun `a rewritten master maps back, every address in it`() {
        val rewritten = rewriteForCast("luminary://asset/1/2.m3u8\nluminary://key\nluminary://live/9\n", base)
        val paths = rewritten.lines().filter { it.isNotEmpty() }.map { it.removePrefix(base) }
        assertEquals(listOf("luminary://asset/1/2.m3u8", "luminary://key", "luminary://live/9"), paths.map { bridgeUriOf(it) })
    }
}
