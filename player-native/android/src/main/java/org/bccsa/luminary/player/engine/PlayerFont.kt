package org.bccsa.luminary.player.engine

import android.content.Context
import android.graphics.Typeface
import android.view.accessibility.CaptioningManager
import android.widget.TextView
import androidx.annotation.FontRes
import androidx.annotation.OptIn
import androidx.core.content.res.ResourcesCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import org.bccsa.luminary.player.R

/**
 * Inter, the web player's typeface, for the native skin. Static weights rather than the variable font, which this
 * module's oldest supported Android cannot vary. A font that fails to load falls back to the system's at that weight.
 */
@OptIn(UnstableApi::class)
object PlayerFont {
    private val cache = HashMap<Int, Typeface>()

    fun regular(context: Context): Typeface = load(context, R.font.inter_regular) { Typeface.DEFAULT }
    fun medium(context: Context): Typeface = load(context, R.font.inter_medium) { Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    fun semibold(context: Context): Typeface = load(context, R.font.inter_semibold) { Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    fun bold(context: Context): Typeface = load(context, R.font.inter_bold) { Typeface.DEFAULT_BOLD }

    /** Tabular figures, so a running time keeps its width as its digits change. */
    fun tabular(view: TextView) {
        view.fontFeatureSettings = "tnum"
    }

    /** [style] in Inter, unless it names a typeface of its own (the viewer's choice in the system settings). */
    fun captions(context: Context, style: CaptionStyleCompat = userCaptions(context)): CaptionStyleCompat =
        CaptionStyleCompat(
            style.foregroundColor, style.backgroundColor, style.windowColor, style.edgeType, style.edgeColor,
            style.typeface ?: semibold(context),
        )

    /** The caption style the player takes from the system settings by default. */
    private fun userCaptions(context: Context): CaptionStyleCompat {
        val manager = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
        return if (manager?.isEnabled == true) CaptionStyleCompat.createFromCaptionStyle(manager.userStyle) else CaptionStyleCompat.DEFAULT
    }

    @Synchronized
    private fun load(context: Context, @FontRes id: Int, fallback: () -> Typeface): Typeface =
        cache.getOrPut(id) { runCatching { ResourcesCompat.getFont(context, id) }.getOrNull() ?: fallback() }
}
