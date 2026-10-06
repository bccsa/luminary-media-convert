package org.bccsa.luminary.player

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private const val KEY_HEX = "000102030405060708090a0b0c0d0e0f"
private const val DIR = "https://live.example.com/channel/video_360"
private const val LIVE_URL = "$DIR/chunks.m3u8"
private const val BASE = "https://cdn.example.com/out/session/stream_720/playlist.m3u8"

private val ENCRYPTED_MEDIA = """
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
#EXT-X-BYTERANGE:120000@0
data_0.m4s
#EXTINF:4.000000,
#EXT-X-BYTERANGE:118000@120000
data_0.m4s
#EXT-X-ENDLIST

""".trimStart()

/** The encoder's AES-128 fixture, still being written. */
private val LIVE_ENCRYPTED = ENCRYPTED_MEDIA.replace("#EXT-X-ENDLIST\n", "")

/** A two-segment window starting at [first], as the packager rewrites it. */
private fun liveWindow(first: Int) = """
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:$first
#EXTINF:4,
l_$first.ts
#EXTINF:4,
l_${first + 1}.ts

""".trimStart()

private fun spec(baseUrl: String = LIVE_URL, keyUri: String? = null, keyHex: String? = null) =
    LiveSpec(LIVE_URL, baseUrl, keyUri?.takeIf { it.isNotEmpty() }, keyHex?.let(::hexBytes), 4.0)

/** An LMCENC payload, as the API's encryptor writes one. */
private fun lmcenc(plaintext: String, keyHex: String = KEY_HEX): ByteArray {
    val iv = ByteArray(16) { 7 }
    val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(hexBytes(keyHex), "AES"), IvParameterSpec(iv))
    return "LMCENC01".toByteArray() + iv + cipher.doFinal(plaintext.toByteArray())
}

/** Answers from [routes], recording every read and every cancel. */
class FakeLiveUpstream(val routes: MutableMap<String, Answer>) {
    sealed interface Answer {
        class Body(val bytes: ByteArray) : Answer
        class Status(val code: Int) : Answer

        /** Never completes, until cancelled. */
        data object Hang : Answer
    }

    val reads = mutableListOf<String>()
    @Volatile var cancels = 0

    val fetch = LiveFetch { url ->
        reads += url
        val answer = routes[url] ?: Answer.Status(404)
        val cancelled = java.util.concurrent.CountDownLatch(1)
        object : LiveRead {
            override fun execute(): ByteArray = when (answer) {
                is Answer.Body -> answer.bytes
                is Answer.Status -> throw LiveFailure.FetchFailed(answer.code)
                Answer.Hang -> {
                    cancelled.await()
                    throw LiveFailure.FetchFailed(null, java.io.IOException("Canceled"))
                }
            }

            override fun cancel() {
                cancels++
                cancelled.countDown()
            }
        }
    }
}

private fun body(text: String) = FakeLiveUpstream.Answer.Body(text.toByteArray())

private fun resolve(spec: LiveSpec, upstream: FakeLiveUpstream): String =
    LiveResolver.resolve(spec, upstream.fetch.start(spec.url))

private fun failureOf(spec: LiveSpec, upstream: FakeLiveUpstream): LiveFailure =
    try {
        resolve(spec, upstream)
        fail("resolved")
        error("unreachable")
    } catch (failure: LiveFailure) {
        failure
    }

/** Ported from `LiveResolverTests.swift` (`policy/live.spec.ts`). */
class LiveResolverTest {
    @Test
    fun `reads the playlist afresh on every call`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE_URL to body(liveWindow(100))))
        val first = resolve(spec(), upstream)
        upstream.routes[LIVE_URL] = body(liveWindow(101))
        val second = resolve(spec(), upstream)

        assertEquals(listOf(LIVE_URL, LIVE_URL), upstream.reads)
        assertTrue(first.contains("$DIR/l_100.ts"))
        assertTrue(second.contains("$DIR/l_102.ts"))
        assertFalse(second.contains("l_100.ts"))
    }

    @Test
    fun `absolutizes every URI against the base, not against where it was read`() {
        val edge = "https://edge.example.com/cache/video_360/chunks.m3u8"
        val text = resolve(spec(baseUrl = edge), FakeLiveUpstream(mutableMapOf(LIVE_URL to body(liveWindow(100)))))
        assertTrue(text.contains("https://edge.example.com/cache/video_360/l_100.ts"))
    }

    @Test
    fun `leaves the tags it does not rewrite exactly as written`() {
        val text = resolve(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to body(liveWindow(100)))))
        assertEquals(
            listOf("#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:100", "#EXTINF:4,"),
            text.split("\n").take(5),
        )
    }

    @Test
    fun `points AES-128 keys at the key URI, leaving IV and the rest alone`() {
        val text = resolve(
            spec(keyUri = "fake:served/key", keyHex = KEY_HEX),
            FakeLiveUpstream(mutableMapOf(LIVE_URL to body(LIVE_ENCRYPTED))),
        )
        assertTrue(text.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"fake:served/key\",IV=0x00000000000000000000000000000001"))
        assertTrue(text.contains("#EXT-X-MAP:URI=\"$DIR/init.mp4\""))
    }

    @Test
    fun `decrypts an LMCENC-wrapped playlist with the session key`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE_URL to FakeLiveUpstream.Answer.Body(lmcenc(liveWindow(100)))))
        assertTrue(resolve(spec(keyUri = KEY_URI, keyHex = KEY_HEX), upstream).contains("$DIR/l_100.ts"))
    }

    @Test
    fun `passes a plaintext playlist through when a key is configured`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE_URL to body(liveWindow(100))))
        assertTrue(resolve(spec(keyUri = KEY_URI, keyHex = KEY_HEX), upstream).contains("$DIR/l_100.ts"))
    }

    @Test
    fun `fails with key-required when an AES-128 key turns up and there is no key`() {
        val failure = failureOf(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to body(LIVE_ENCRYPTED))))
        assertTrue(failure is LiveFailure.KeyRequired)
    }

    @Test
    fun `does not count METHOD=NONE as a key`() {
        val playlist = liveWindow(100).replace("#EXTINF:4,\nl_100", "#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nl_100")
        val text = resolve(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to body(playlist))))
        assertTrue(text.contains("#EXT-X-KEY:METHOD=NONE\n"))
    }

    @Test
    fun `fails with key-required on an LMCENC playlist when there is no key`() {
        val failure = failureOf(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to FakeLiveUpstream.Answer.Body(lmcenc(liveWindow(100))))))
        assertTrue(failure is LiveFailure.KeyRequired)
    }

    @Test
    fun `fails with decrypt-failed under the wrong key`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE_URL to FakeLiveUpstream.Answer.Body(lmcenc(liveWindow(100)))))
        val failure = failureOf(spec(keyUri = KEY_URI, keyHex = "ffffffffffffffffffffffffffffffff"), upstream)
        assertTrue(failure is LiveFailure.DecryptFailed)
    }

    @Test
    fun `fails with invalid-content on something that is not a playlist`() {
        val failure = failureOf(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to body("<html>Gateway timeout</html>"))))
        assertTrue(failure is LiveFailure.InvalidContent)
    }

    @Test
    fun `fails with the status the upstream answered with`() {
        for (status in listOf(404, 503)) {
            val failure = failureOf(spec(), FakeLiveUpstream(mutableMapOf(LIVE_URL to FakeLiveUpstream.Answer.Status(status))))
            assertEquals(status, (failure as LiveFailure.FetchFailed).status)
        }
    }

    @Test
    fun `an empty key URI names no key, so key lines stay as written and an AES-128 key needs one`() {
        val key = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k/x\"\n#EXTINF:4,\na.m4s\n"
        assertTrue(rewriteMediaPlaylist(key, BASE, "").contains("URI=\"https://k/x\""))
        val failure = try {
            LiveResolver.decode(key.toByteArray(), LiveSpec(BASE, BASE, "".takeIf { it.isNotEmpty() }, null, 4.0))
            null
        } catch (failure: LiveFailure) {
            failure
        }
        assertTrue(failure is LiveFailure.KeyRequired)
    }

    @Test
    fun `a spec from the bridge reads an empty keyUri as absent and zeroes its key on request`() {
        val live = LiveSpec.of(BridgeLiveSpec(LIVE_URL, LIVE_URL, "", KEY_HEX, 4.0))
        assertEquals(null, live.keyUri)
        assertEquals(16, live.keyBytes!!.size)
        live.zero()
        assertEquals(null, live.keyBytes)
    }
}

/** Ported from `MediaPlaylistRewriteTests` (`pipeline/rewrite-media.spec.ts`). */
class MediaPlaylistRewriteTest {
    private val plain = """
        #EXTM3U
        #EXT-X-VERSION:7
        #EXT-X-TARGETDURATION:4
        #EXT-X-MAP:URI="init.mp4"
        #EXTINF:4.000000,
        segment_0.m4s
        #EXT-X-ENDLIST

    """.trimIndent() + "\n"

    @Test
    fun `absolutizes segment URIs and EXT-X-MAP against the original URL`() {
        val out = rewriteMediaPlaylist(plain, BASE, null)
        assertTrue(out.contains("URI=\"https://cdn.example.com/out/session/stream_720/init.mp4\""))
        assertTrue(out.contains("https://cdn.example.com/out/session/stream_720/segment_0.m4s"))
    }

    @Test
    fun `keeps query strings on the playlist URL out of the segment URLs`() {
        val out = rewriteMediaPlaylist(plain, "$BASE?token=abc", null)
        assertTrue(out.contains("https://cdn.example.com/out/session/stream_720/segment_0.m4s\n"))
    }

    @Test
    fun `carries query strings on the segment URI through`() {
        val out = rewriteMediaPlaylist("#EXTM3U\n#EXTINF:4,\nseg.m4s?v=2\n", BASE, null)
        assertTrue(out.contains("https://cdn.example.com/out/session/stream_720/seg.m4s?v=2"))
    }

    @Test
    fun `leaves BYTERANGE untouched`() {
        val out = rewriteMediaPlaylist(ENCRYPTED_MEDIA, BASE, KEY_URI)
        assertTrue(out.contains("#EXT-X-BYTERANGE:120000@0"))
        assertTrue(out.contains("#EXT-X-BYTERANGE:118000@120000"))
    }

    @Test
    fun `overrides a real key URL, the supplied session key wins`() {
        val text = ENCRYPTED_MEDIA.replace(KEY_URI, "https://keys.example.com/session/abc.key")
        val out = rewriteMediaPlaylist(text, BASE, KEY_URI)
        assertTrue(out.contains("URI=\"$KEY_URI\""))
        assertFalse(out.contains("keys.example.com"))
    }

    @Test
    fun `leaves METHOD=NONE alone`() {
        val out = rewriteMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.m4s\n", BASE, "fake:key")
        assertTrue(out.contains("#EXT-X-KEY:METHOD=NONE\n"))
        assertFalse(out.contains("fake:key"))
    }

    @Test
    fun `leaves key lines alone when no key URI is supplied`() {
        assertTrue(rewriteMediaPlaylist(ENCRYPTED_MEDIA, BASE, null).contains("URI=\"$KEY_URI\""))
    }

    @Test
    fun `keeps KEYFORMAT attributes while normalizing the URI`() {
        val text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"luminary://key\",IV=0x0f,KEYFORMAT=\"identity\",KEYFORMATVERSIONS=\"1\"\n#EXTINF:4,\na.m4s\n"
        val out = rewriteMediaPlaylist(text, BASE, "fake:key")
        assertTrue(out.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"fake:key\",IV=0x0f,KEYFORMAT=\"identity\",KEYFORMATVERSIONS=\"1\""))
    }

    @Test
    fun `completes a key line that names no URI`() {
        val out = rewriteMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,IV=0x01\n", BASE, "fake:key")
        assertTrue(out.contains("#EXT-X-KEY:METHOD=AES-128,IV=0x01,URI=\"fake:key\""))
    }

    @Test
    fun `a key URI with dollar signs is written literally`() {
        val out = rewriteMediaPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"x\"\n", BASE, "https://k/\$1?a=\\b")
        assertTrue(out.contains("URI=\"https://k/\$1?a=\\b\""))
    }

    @Test
    fun `absolutizes URI attributes on tags it does not know, resolving dot segments`() {
        val text = "#EXTM3U\n#EXT-X-RENDITION-REPORT:URI=\"../audio/playlist.m3u8\",LAST-MSN=42\n#EXTINF:4,\na.m4s\n"
        val out = rewriteMediaPlaylist(text, BASE, null)
        assertTrue(out.contains("URI=\"https://cdn.example.com/out/session/audio/playlist.m3u8\",LAST-MSN=42"))
    }

    @Test
    fun `resolves a chunk named again after another URI, however they interleave`() {
        val text = "#EXTM3U\n#EXTINF:4,\n../media/a_0.m4s\n#EXTINF:4,\n../media/a_1.m4s\n#EXTINF:4,\n../media/a_0.m4s\n"
        val segments = rewriteMediaPlaylist(text, BASE, null).split("\n").filter { it.isNotEmpty() && !it.startsWith("#") }
        assertEquals(
            listOf(
                "https://cdn.example.com/out/session/media/a_0.m4s",
                "https://cdn.example.com/out/session/media/a_1.m4s",
                "https://cdn.example.com/out/session/media/a_0.m4s",
            ),
            segments,
        )
    }

    @Test
    fun `resolves as the URL parser does, a trailing space goes, brackets and pipes stay, spaces and non-ASCII encode`() {
        fun resolved(uri: String) = rewriteMediaPlaylist("#EXTM3U\n#EXTINF:4,\n$uri\n", BASE, null).split("\n").filter { it.isNotEmpty() }.last()
        val dir = "https://cdn.example.com/out/session/stream_720/"
        assertEquals(dir + "seg.m4s", resolved("seg.m4s "))
        assertEquals(dir + "seg.m4s?a=1&b=[2]|3", resolved("seg.m4s?a=1&b=[2]|3"))
        assertEquals(dir + "my%20seg%20%C3%A9.m4s", resolved("my seg é.m4s"))
        assertEquals("https://cdn.example.com/abs/seg.m4s?x=1#frag", resolved("/abs/seg.m4s?x=1#frag"))
        assertEquals("https://other.example.com/b/seg.m4s", resolved("//other.example.com/a/../b/seg.m4s"))
        assertEquals("https://cdn.example.com/out/x/y.m4s", resolved("../../x/./y.m4s"))
        assertEquals("https://cdn.example.com/a.m4s", resolved("https://CDN.Example.com:443/a.m4s"))
        assertEquals("https://cdn.example.com/a/x.m4s", resolveReference("x.m4s", "HTTPS://CDN.Example.com:443/a/b.m3u8?t=1"))
    }

    @Test
    fun `a key line naming no method, or an empty one, is no key`() {
        assertFalse(hasAes128Key("#EXTM3U\n#EXT-X-KEY:URI=\"k\"\n"))
        assertFalse(hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=,URI=\"k\"\n"))
        assertFalse(hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n"))
        assertTrue(hasAes128Key("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n"))
    }

    @Test
    fun `keeps a line's carriage return, and the text around it`() {
        val out = rewriteMediaPlaylist("#EXTM3U\r\n#EXTINF:4.000000,\r\nsegment_0.m4s\r\n", BASE, null)
        assertEquals("#EXTM3U\r\n#EXTINF:4.000000,\r\nhttps://cdn.example.com/out/session/stream_720/segment_0.m4s\r\n", out)
    }
}
