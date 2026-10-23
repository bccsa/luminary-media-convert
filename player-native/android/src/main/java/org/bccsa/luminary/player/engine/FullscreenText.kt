package org.bccsa.luminary.player.engine

/**
 * video.js's `formatTime`: `m:ss`, with hours when [guide] (the duration) reaches an hour. A
 * negative time reads as 0; one that is not a number reads `-:-` (`-:-:-` with hours).
 */
internal fun formatTime(seconds: Double, guide: Double): String {
    val guideWhole = if (guide.isFinite()) maxOf(guide.toLong(), 0L) else 0L
    if (!seconds.isFinite()) return if (guideWhole / 3600 > 0) "-:-:-" else "-:-"
    val whole = maxOf(seconds, 0.0).toLong()
    val h = whole / 3600
    val m = (whole / 60) % 60
    val s = whole % 60
    val sText = if (s < 10) "0$s" else "$s"
    if (h > 0 || guideWhole / 3600 > 0) {
        val mText = if (m < 10) "0$m" else "$m"
        return "$h:$mText:$sText"
    }
    // Minutes are padded when the guide has ten or more of them, as video.js does.
    val mText = if ((guideWhole / 60) % 60 >= 10 && m < 10) "0$m" else "$m"
    return "$mText:$sText"
}

/** The time row (native only): `0:07 / 2:00`, or `LIVE`. */
internal fun timeText(live: Boolean, position: Double, duration: Double): String {
    if (live) return "LIVE"
    val total = maxOf(duration, position)
    return "${formatTime(position, total)} / ${formatTime(total, total)}"
}
