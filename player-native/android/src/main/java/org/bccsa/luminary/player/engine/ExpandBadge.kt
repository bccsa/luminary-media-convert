package org.bccsa.luminary.player.engine

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/**
 * The page's way up on a small picture in front: a dark round badge with a chevron, matching the one the page
 * draws over a cover. It takes no touches, so a tap reaches the page's own button underneath.
 */
class ExpandBadge(context: Context) : View(context) {
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(140, 0, 0, 0) }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val chevron = Path()

    init {
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onDraw(canvas: Canvas) {
        val side = width.coerceAtMost(height).toFloat()
        val radius = side / 2
        canvas.drawCircle(width / 2f, height / 2f, radius, disc)
        // The page's chevron-up, in a 24-unit box: from (4.5, 15.75) up to (12, 8.25) and down to (19.5, 15.75), at
        // a little over half the badge.
        val scale = side * 0.55f / 24f
        val left = width / 2f - 12f * scale
        val top = height / 2f - 12f * scale
        stroke.strokeWidth = 2.6f * scale
        chevron.reset()
        chevron.moveTo(left + 4.5f * scale, top + 15.75f * scale)
        chevron.lineTo(left + 12f * scale, top + 8.25f * scale)
        chevron.lineTo(left + 19.5f * scale, top + 15.75f * scale)
        canvas.drawPath(chevron, stroke)
    }

    companion object {
        /** Its side, and its place from the picture's top-left corner, in dp: the page's own badge. */
        const val SIZE_DP = 24f
        const val INSET_X_DP = 6f
        const val INSET_Y_DP = 10f
    }
}
