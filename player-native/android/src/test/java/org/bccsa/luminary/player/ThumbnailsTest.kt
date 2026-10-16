package org.bccsa.luminary.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The scrub frames' VTT, read the way `hls-core`'s `parseThumbnailVtt` reads it, and the roster's arithmetic. */
class ThumbnailsTest {
    private val vtt = """
        WEBVTT

        00:00:00.000 --> 00:00:01.000
        sprite_0.webp#xywh=0,0,160,90

        00:00:01.000 --> 00:00:02.500
        sprite_0.webp#xywh=160,0,160,90

        00:01:00.000 --> 00:01:01.000
        https://cdn.example.com/other.webp#xywh=0,90,160,90
    """.trimIndent()

    @Test
    fun `cues come back in order, sprite paths resolved against the VTT's folder`() {
        val cues = ThumbnailVtt.parse(vtt, "https://bucket.example.com/abc/thumbnails")

        assertEquals(3, cues.size)
        assertEquals("https://bucket.example.com/abc/thumbnails/sprite_0.webp", cues[0].url)
        assertEquals(ThumbnailCue(1.0, 2.5, "https://bucket.example.com/abc/thumbnails/sprite_0.webp", 160, 0, 160, 90), cues[1])
        // An absolute address is left alone.
        assertEquals("https://cdn.example.com/other.webp", cues[2].url)
        assertEquals(60.0, cues[2].start, 0.0)
    }

    @Test
    fun `a file with CRLF line endings is still every cue, not the first`() {
        val cues = ThumbnailVtt.parse(vtt.replace("\n", "\r\n"), "base")

        assertEquals(3, cues.size)
    }

    @Test
    fun `a lookup lands on the cue that covers the time, ends being exclusive`() {
        val cues = ThumbnailVtt.parse(vtt, "base")

        assertEquals(0.0, ThumbnailVtt.find(cues, 0.5)!!.start, 0.0)
        assertEquals(1.0, ThumbnailVtt.find(cues, 1.0)!!.start, 0.0)
        assertEquals(1.0, ThumbnailVtt.find(cues, 2.4)!!.start, 0.0)
        assertNull(ThumbnailVtt.find(cues, 2.5))
        assertNotNull(ThumbnailVtt.find(cues, 60.5))
        assertNull(ThumbnailVtt.find(emptyList(), 1.0))
    }

    @Test
    fun `a cue with no crop is the whole image`() {
        val cues = ThumbnailVtt.parse("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nframe.webp\n", "base")

        assertEquals(0, cues.single().w)
    }

    @Test
    fun `the roster keeps each slot on its own time while the playhead moves`() {
        val a = Roster.tiles(100.0, 200f, 800f, 100f, 10.0, 1000.0).associateBy { it.index }
        val b = Roster.tiles(105.0, 200f, 800f, 100f, 10.0, 1000.0).associateBy { it.index }

        assertEquals(a.getValue(10).time, b.getValue(10).time, 0.0)
        assertEquals(50f, a.getValue(10).left - b.getValue(10).left, 0.001f)
    }

    @Test
    fun `the playhead is under the marker`() {
        val under = Roster.tiles(100.0, 200f, 800f, 100f, 10.0, 1000.0).single { it.left <= 200f && it.left + 100f > 200f }

        assertTrue(under.time - 5 <= 100.0 && under.time + 5 > 100.0)
    }

    @Test
    fun `slots outside the media are left out`() {
        val tiles = Roster.tiles(2.0, 400f, 800f, 100f, 10.0, 30.0)

        assertTrue(tiles.all { it.time >= 0 && it.time < 30 })
        assertEquals(0, tiles.minOf { it.index })
        assertEquals(2, tiles.maxOf { it.index })
        assertTrue(Roster.tiles(0.0, 0f, 0f, 100f, 10.0, 100.0).isEmpty())
    }

    @Test
    fun `a frame is a second to a clip and fifteen at most to a long one`() {
        assertEquals(1.0, Roster.step(30.0), 0.0)
        assertEquals(10.0, Roster.step(1200.0), 0.0)
        assertEquals(15.0, Roster.step(100000.0), 0.0)
    }
}
