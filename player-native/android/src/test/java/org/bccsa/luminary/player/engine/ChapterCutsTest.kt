package org.bccsa.luminary.player.engine

import org.bccsa.luminary.player.BrowseChapter
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors `chapterMask` and `formatChapterOf` in `player-web`. */
class ChapterCutsTest {
    private fun chapter(start: Double, title: String = "at $start") = BrowseChapter(title, start, start + 1)

    @Test
    fun `a cut sits at each chapter start after the first`() {
        val cuts = ChapterCuts.starts(listOf(chapter(0.0), chapter(10.0), chapter(40.0)), 100.0)
        assertEquals(listOf(0.1f, 0.4f), cuts)
    }

    @Test
    fun `time before the first chapter is a stretch of its own`() {
        assertEquals(listOf(0.1f), ChapterCuts.starts(listOf(chapter(10.0)), 100.0))
    }

    @Test
    fun `one stretch, no duration or a start past the end is one plain bar`() {
        assertEquals(emptyList<Float>(), ChapterCuts.starts(listOf(chapter(0.0)), 100.0))
        assertEquals(emptyList<Float>(), ChapterCuts.starts(listOf(chapter(0.0), chapter(10.0)), 0.0))
        assertEquals(emptyList<Float>(), ChapterCuts.starts(listOf(chapter(0.0), chapter(500.0)), 100.0))
    }

    @Test
    fun `duplicate starts are one cut`() {
        assertEquals(listOf(0.5f), ChapterCuts.starts(listOf(chapter(0.0), chapter(50.0), chapter(50.0)), 100.0))
    }

    @Test
    fun `past sixty stretches the bar stays whole`() {
        val many = (0 until 61).map { chapter(it.toDouble()) }
        assertEquals(emptyList<Float>(), ChapterCuts.starts(many, 100.0))
    }

    @Test
    fun `a dense bar is cut with hairlines`() {
        assertEquals(1.5f, ChapterCuts.halfGapDp(16))
        assertEquals(0.5f, ChapterCuts.halfGapDp(17))
    }

    @Test
    fun `the label says which chapter of how many, and its title`() {
        val chapters = listOf(chapter(0.0, "Intro"), chapter(10.0, ""))
        assertEquals("Chapter 1 of 2 · Intro", ChapterCuts.nowText("Chapter {index} of {count}", chapters, 0))
        assertEquals("Chapitre 2 sur 2", ChapterCuts.nowText("Chapitre {index} sur {count}", chapters, 1))
    }

    @Test
    fun `there is no label for fewer than two chapters or none playing`() {
        assertEquals("", ChapterCuts.nowText("Chapter {index} of {count}", listOf(chapter(0.0)), 0))
        assertEquals("", ChapterCuts.nowText("Chapter {index} of {count}", listOf(chapter(0.0), chapter(1.0)), -1))
    }
}
