package org.bccsa.luminary.player

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.bccsa.luminary.player.conformance.FakeEngine
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private const val BASE = "https://cdn.example.com/out/session"

/** One chain of three chunk objects, 20 s of media each. */
private val CHAIN = listOf(
    ChunkBoundary("$BASE/media/v0_0.m4s", 0.0, 20.0),
    ChunkBoundary("$BASE/media/v0_1.m4s", 20.0, 40.0),
    ChunkBoundary("$BASE/media/v0_2.m4s", 40.0, 60.0),
)

/** Ported from `ChunkWarmerTests.swift`, which is `player-web/__tests__/chunkWarming.test.ts` case for case. */
class ChunkWarmerTest {
    private inner class Run(schedules: List<List<ChunkBoundary>>, leadSeconds: Double = 10.0) {
        val clock = VirtualClock()
        var watermark = 0.0
        var samples = 0
        val warmed = mutableListOf<String>()
        val bytes = mutableListOf<Int>()
        val warmer = ChunkWarmer(
            clock,
            {
                samples++
                watermark
            },
            { url, count ->
                warmed += url
                bytes += count
            },
        )

        init {
            warmer.start(schedules, leadSeconds, 1024)
        }
    }

    @Test
    fun `warms each next chunk once as the buffer approaches it`() {
        val run = Run(listOf(CHAIN))
        run.watermark = 12.0
        run.clock.advance(3.0)
        assertEquals(listOf("$BASE/media/v0_1.m4s"), run.warmed)

        run.watermark = 32.0
        run.clock.advance(3.0)
        assertEquals(listOf("$BASE/media/v0_1.m4s", "$BASE/media/v0_2.m4s"), run.warmed)
    }

    @Test
    fun `asks for the first warmBytes, as a range`() {
        val run = Run(listOf(CHAIN))
        run.watermark = 12.0
        run.clock.advance(1.0)
        assertEquals(listOf(1024), run.bytes)
    }

    @Test
    fun `waits until the buffer front is within the lead`() {
        val run = Run(listOf(CHAIN))
        run.watermark = 9.0
        run.clock.advance(5.0)
        assertTrue(run.warmed.isEmpty())
    }

    @Test
    fun `keeps sampling while any chunk is still to be warmed`() {
        // Paused just short of the first boundary, the next chunk has to be warmed before play.
        val run = Run(listOf(CHAIN))
        run.watermark = 12.0
        run.clock.advance(1.0)
        val afterFirstWarm = run.samples
        run.clock.advance(5.0)
        assertEquals(afterFirstWarm + 5, run.samples)
    }

    @Test
    fun `stops sampling once every chunk has been warmed`() {
        val run = Run(listOf(CHAIN))
        run.watermark = 12.0
        run.clock.advance(1.0)
        run.watermark = 32.0
        run.clock.advance(1.0)
        val atLastWarm = run.samples
        run.clock.advance(60.0)
        assertEquals(atLastWarm, run.samples)
        assertFalse(run.warmer.ticking)
    }

    @Test
    fun `waits for every chain, not only the first to finish`() {
        val audio = listOf(
            ChunkBoundary("$BASE/media/a_0.m4s", 0.0, 50.0),
            ChunkBoundary("$BASE/media/a_1.m4s", 50.0, 100.0),
        )
        val run = Run(listOf(CHAIN, audio))
        run.watermark = 12.0
        run.clock.advance(1.0)
        run.watermark = 32.0
        run.clock.advance(1.0)
        assertEquals(listOf("$BASE/media/v0_1.m4s", "$BASE/media/v0_2.m4s"), run.warmed)

        val before = run.samples
        run.clock.advance(3.0)
        assertEquals(before + 3, run.samples)

        run.watermark = 45.0
        run.clock.advance(1.0)
        assertTrue(run.warmed.contains("$BASE/media/a_1.m4s"))
        val done = run.samples
        run.clock.advance(10.0)
        assertEquals(done, run.samples)
    }

    @Test
    fun `keeps sampling while a chunk skipped by a seek is still unwarmed`() {
        // A seek back can still make that boundary the next one.
        val run = Run(listOf(CHAIN))
        run.watermark = 32.0
        run.clock.advance(1.0)
        assertEquals(listOf("$BASE/media/v0_2.m4s"), run.warmed)

        val before = run.samples
        run.clock.advance(3.0)
        assertEquals(before + 3, run.samples)

        run.watermark = 12.0
        run.clock.advance(1.0)
        assertEquals(listOf("$BASE/media/v0_2.m4s", "$BASE/media/v0_1.m4s"), run.warmed)
        val done = run.samples
        run.clock.advance(10.0)
        assertEquals(done, run.samples)
    }

    @Test
    fun `never starts sampling when there is nothing to warm`() {
        // A chain of one chunk: the engine's own start-up request fetches it.
        val run = Run(listOf(listOf(ChunkBoundary("$BASE/media/v0_0.m4s", 0.0, 60.0))))
        run.clock.advance(10.0)
        assertEquals(0, run.samples)
        assertFalse(run.warmer.ticking)
    }

    @Test
    fun `does not start again for chunks it has already warmed`() {
        // Armed again with the same chains: at most once is per attached source.
        val run = Run(listOf(CHAIN))
        run.watermark = 12.0
        run.clock.advance(1.0)
        run.watermark = 32.0
        run.clock.advance(1.0)

        run.warmer.start(listOf(CHAIN), 10.0, 1024)
        val armed = run.samples
        run.clock.advance(10.0)
        assertEquals(armed, run.samples)
        assertEquals(2, run.warmed.size)
    }

    @Test
    fun `an empty schedule list stops it`() {
        val run = Run(listOf(CHAIN))
        run.warmer.start(emptyList(), 10.0, 1024)
        run.watermark = 12.0
        run.clock.advance(5.0)
        assertEquals(0, run.samples)
        assertTrue(run.warmed.isEmpty())
    }

    @Test
    fun `a run continuing in the same object needs nothing`() {
        val run = Run(
            listOf(
                listOf(
                    ChunkBoundary("$BASE/media/v0_0.m4s", 0.0, 20.0),
                    ChunkBoundary("$BASE/media/v0_0.m4s", 20.0, 40.0),
                    ChunkBoundary("$BASE/media/v0_1.m4s", 40.0, 60.0),
                ),
            ),
        )
        run.watermark = 12.0
        run.clock.advance(1.0)
        assertTrue(run.warmed.isEmpty())
        run.watermark = 32.0
        run.clock.advance(1.0)
        assertEquals(listOf("$BASE/media/v0_1.m4s"), run.warmed)
    }

    @Test
    fun `an unknown buffer front warms nothing and keeps looking`() {
        val run = Run(listOf(CHAIN))
        run.watermark = Double.NaN
        run.clock.advance(3.0)
        assertTrue(run.warmed.isEmpty())
        run.watermark = 12.0
        run.clock.advance(1.0)
        assertEquals(1, run.warmed.size)
    }

    @Test
    fun `a fetch that throws changes nothing and is not retried`() {
        val clock = VirtualClock()
        var attempts = 0
        val warmer = ChunkWarmer(clock, { 12.0 }, { _, _ ->
            attempts++
            throw IllegalStateException("offline")
        })
        warmer.start(listOf(CHAIN), 10.0, 1024)
        clock.advance(5.0)
        assertEquals(1, attempts)
        assertTrue(warmer.ticking)
    }

    @Test
    fun `reads schedules from the bridge, skipping incomplete boundaries`() {
        val json = buildJsonArray {
            add(
                buildJsonArray {
                    add(buildJsonObject { put("url", "a"); put("start", 0); put("end", 20) })
                    add(buildJsonObject { put("url", "b"); put("start", 20) })
                    add(buildJsonObject { put("url", "c"); put("start", "x"); put("end", 40) })
                },
            )
        }
        assertEquals(listOf(listOf(ChunkBoundary("a", 0.0, 20.0))), ChunkBoundary.schedules(json))
    }
}

/**
 * How `warmChunks` reaches a player's [ChunkWarmer]: only for the current load, stopped by the next
 * load and by destroy. The loop itself is pinned above.
 */
class ChunkWarmingWiringTest {
    private class Run(chunkWarming: Boolean = true) {
        val clock = VirtualClock()
        val warmed = mutableListOf<String>()
        val registry = PlayerRegistry(
            BridgeCapabilities(chunkWarming = chunkWarming),
            clock,
            upstream = null,
            EngineFactory { _, clock, _ -> FakeEngine(clock, mutableListOf()) },
            warmFetch = { url, _ -> warmed += url },
        ) { _, _ -> }
        val playerId = registry.call(
            "create",
            buildJsonObject {
                put("protocolVersion", 1)
                put("skipBackSeconds", 10)
                put("skipForwardSeconds", 10)
            },
        ).let { (it as kotlinx.serialization.json.JsonObject).getValue("playerId").let { id -> (id as kotlinx.serialization.json.JsonPrimitive).content } }

        fun load(loadId: String, generation: Int) {
            registry.call(
                "load",
                buildJsonObject {
                    put("playerId", playerId)
                    put("loadId", loadId)
                    put("generation", generation)
                    put("masterUri", "luminary://asset/$generation/1.m3u8")
                    put(
                        "assets",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("uri", "luminary://asset/$generation/1.m3u8")
                                    put("contentType", "application/vnd.apple.mpegurl")
                                    put("text", "#EXTM3U\n")
                                },
                            )
                        },
                    )
                    put(
                        "recovery",
                        buildJsonObject {
                            put("escalationWindowMs", 10000)
                            put("maxReloadAttempts", 3)
                            put("reloadDelaysMs", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive(2000)) })
                        },
                    )
                },
            )
        }

        /** A chain whose second chunk is within a 60 s lead from position 0: warmed on the first tick. */
        fun warm(loadId: String) {
            fun boundary(url: String, start: Int) = buildJsonObject {
                put("url", url)
                put("start", start)
                put("end", start + 20)
            }
            registry.call(
                "warmChunks",
                buildJsonObject {
                    put("playerId", playerId)
                    put("loadId", loadId)
                    put(
                        "schedules",
                        buildJsonArray {
                            add(buildJsonArray { add(boundary("https://cdn.test/v_0.m4s", 0)); add(boundary("https://cdn.test/v_1.m4s", 20)) })
                        },
                    )
                    put("leadSeconds", 60)
                    put("warmBytes", 65536)
                },
            )
        }
    }

    @Test
    fun `warms for the current load`() {
        val run = Run()
        run.load("load-1", 1)
        run.warm("load-1")
        run.clock.advance(1.0)
        assertEquals(listOf("https://cdn.test/v_1.m4s"), run.warmed)
    }

    @Test
    fun `ignores a call for a load that has been replaced`() {
        val run = Run()
        run.load("load-1", 1)
        run.load("load-2", 2)
        run.warm("load-1")
        run.clock.advance(5.0)
        assertTrue(run.warmed.isEmpty())
    }

    @Test
    fun `a new load stops the warming of the one it replaces`() {
        val run = Run()
        run.load("load-1", 1)
        run.warm("load-1")
        run.load("load-2", 2)
        run.clock.advance(5.0)
        assertTrue(run.warmed.isEmpty())
    }

    @Test
    fun `destroy stops it`() {
        val run = Run()
        run.load("load-1", 1)
        run.warm("load-1")
        run.registry.call("destroy", buildJsonObject { put("playerId", run.playerId) })
        run.clock.advance(5.0)
        assertTrue(run.warmed.isEmpty())
    }

    @Test
    fun `refused while the capability is off`() {
        val run = Run(chunkWarming = false)
        try {
            run.registry.call("warmChunks", buildJsonObject { put("playerId", run.playerId) })
            fail("accepted")
        } catch (rejection: BridgeRejection) {
            assertEquals(BridgeErrorCode.UNSUPPORTED, rejection.code)
        }
    }
}
