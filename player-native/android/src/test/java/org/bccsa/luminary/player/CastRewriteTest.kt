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

    @Test
    fun `a pinned variant leaves the master with that rendition alone, its audio groups and every other tag kept`() {
        val master = "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"a.m3u8\"\r\n" +
            "#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO=\"a\"\r\nv720.m3u8\r\n" +
            "#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO=\"a\"\r\nv360.m3u8\r\n"
        assertEquals(
            "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"a.m3u8\"\r\n" +
                "#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO=\"a\"\r\nv360.m3u8\r\n",
            pinVariant(master, "360_300000"),
        )
        // The engine names a variant by its BANDWIDTH, never its AVERAGE-BANDWIDTH.
        assertEquals(master, pinVariant(master, "720_800000"))
    }

    @Test
    fun `a variant the master does not offer leaves it as it is, and so does a resolution-less one by its own id`() {
        val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\naudio.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nhigh.m3u8\n"
        assertEquals(master, pinVariant(master, "720_900000"))
        assertEquals("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\naudio.m3u8\n", pinVariant(master, "0_64000"))
    }
}
