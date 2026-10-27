package org.bccsa.luminary.player.engine

import org.bccsa.luminary.player.BrowseChapter

/** How the timeline is cut at chapter starts; the web player's `chapterMask` and `formatChapterOf`, so a bar reads the same everywhere. */
internal object ChapterCuts {
    /** Past this many stretches the gap gives way to a hairline. */
    const val DENSE = 16

    /** Past this many a cut every few pixels is noise, and the bar stays one plain bar. */
    const val MAX = 60

    /** Half the gap between two chapters, in dp at the normal scale. */
    const val HALF_GAP_DP = 1.5f

    /** The same for a bar with many chapters. */
    const val HALF_HAIRLINE_DP = 0.5f

    /** Where each chapter after the first starts, as a fraction of the bar; empty when the bar stays whole. */
    fun starts(chapters: List<BrowseChapter>, durationSeconds: Double): List<Float> {
        if (!(durationSeconds > 0)) return emptyList()
        val times = chapters.map { maxOf(it.start, 0.0) }.filter { it < durationSeconds }.distinct().sorted().toMutableList()
        if (times.isEmpty()) return emptyList()
        // Time before the first chapter is a stretch of its own.
        if (times.first() > 0) times.add(0, 0.0)
        if (times.size < 2 || times.size > MAX) return emptyList()
        return times.drop(1).map { (it / durationSeconds).toFloat() }
    }

    /** Half the gap, in dp at the normal scale, for a bar of [stretches] stretches. */
    fun halfGapDp(stretches: Int) = if (stretches > DENSE) HALF_HAIRLINE_DP else HALF_GAP_DP

    /** "Chapter 4 of 7", with the chapter's title after it when it has one. */
    fun nowText(template: String, chapters: List<BrowseChapter>, index: Int): String {
        if (chapters.size < 2 || index !in chapters.indices) return ""
        val title = chapters[index].title
        val head = template.replace("{index}", (index + 1).toString()).replace("{count}", chapters.size.toString())
        return if (title.isEmpty()) head else "$head · $title"
    }
}
