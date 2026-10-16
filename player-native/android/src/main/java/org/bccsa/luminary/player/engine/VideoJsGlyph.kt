package org.bccsa.luminary.player.engine

import android.graphics.Matrix
import android.graphics.Path
import androidx.core.graphics.PathParser

/** One glyph of video.js's icon font ([VideoJsIcons]), drawn as a path. */
internal class VideoJsGlyph(
    /** Width in font units; most glyphs are one em. */
    val advance: Double,
    /** SVG path data in font units, y upwards. */
    val path: String,
) {
    /**
     * The glyph in a square of [size] pixels, y downwards, as CSS draws a font glyph of that size:
     * one em is [size], centred horizontally on its advance.
     */
    fun path(size: Float): Path {
        val scale = size / VideoJsIcons.UNITS_PER_EM
        val shift = (VideoJsIcons.UNITS_PER_EM - advance.toFloat()) / 2
        val parsed = PathParser.createPathFromPathData(path)
        parsed.transform(
            Matrix().apply {
                setScale(scale, -scale)
                postTranslate(shift * scale, size)
            },
        )
        return parsed
    }
}
