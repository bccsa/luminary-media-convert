package org.bccsa.luminary.spike

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.CornerPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import kotlin.math.cos
import kotlin.math.sin

/*
 * The iOS spike's look (SwiftUI over AVPlayerViewController), rebuilt in plain Views so the two
 * spikes read the same side by side: overlay transport controls, a segmented control, capsule
 * buttons, and a monospace log.
 */

object Ios {
    const val BLUE = 0xFF007AFF.toInt()
    const val CAPSULE = 0xFFE9E9EB.toInt()
    const val SEGMENT_TRACK = 0xFFEEEEF0.toInt()
    const val CONTROL = 0xE61C1C1E.toInt()
    const val SECONDARY = 0xFF8E8E93.toInt()
}

fun Context.dp(value: Number): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

fun View.dp(value: Number): Int = context.dp(value)

private fun capsule(color: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = 1000f
}

/** A `.bordered` SwiftUI button; [prominent] is `.borderedProminent`, for the current choice. */
fun Context.capsuleButton(label: String, prominent: Boolean = false, onClick: () -> Unit) = TextView(this).apply {
    text = label
    textSize = 17f
    setTextColor(if (prominent) Color.WHITE else Ios.BLUE)
    background = capsule(if (prominent) Ios.BLUE else Ios.CAPSULE)
    setPadding(dp(16), dp(9), dp(16), dp(9))
    isClickable = true
    setOnClickListener { onClick() }
    layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { setMargins(dp(4), dp(4), dp(4), dp(4)) }
}

/** A row of capsules, centred while they fit and scrolling once they do not. */
class CapsuleRow(context: Context) : HorizontalScrollView(context) {
    val content = LinearLayout(context).apply { gravity = Gravity.CENTER }

    init {
        isFillViewport = true
        isHorizontalScrollBarEnabled = false
        addView(content, LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }

    fun set(views: List<View>) {
        content.removeAllViews()
        views.forEach(content::addView)
    }
}

/** A small grey heading over a group, as a SwiftUI `Section` header. */
fun Context.sectionHeader(text: String) = TextView(this).apply {
    this.text = text.uppercase()
    textSize = 12f
    letterSpacing = 0.04f
    setTextColor(Ios.SECONDARY)
    setPadding(dp(8), dp(10), dp(8), dp(2))
}

fun Context.logView() = TextView(this).apply {
    typeface = Typeface.MONOSPACE
    textSize = 12f
    setTextColor(Color.BLACK)
    setTextIsSelectable(true)
    setPadding(0, dp(8), 0, dp(8))
}

/** SwiftUI's `.segmented` picker. */
class SegmentedControl(context: Context, labels: List<String>, selected: Int, private val onSelect: (Int) -> Unit) :
    LinearLayout(context) {
    private val segments = labels.mapIndexed { index, label ->
        TextView(context).apply {
            text = label
            textSize = 17f
            gravity = Gravity.CENTER
            setTextColor(Color.BLACK)
            setOnClickListener { select(index) }
        }
    }

    init {
        background = capsule(Ios.SEGMENT_TRACK)
        setPadding(dp(3), dp(3), dp(3), dp(3))
        segments.forEach { addView(it, LayoutParams(0, dp(40), 1f)) }
        show(selected)
    }

    private fun select(index: Int) {
        show(index)
        onSelect(index)
    }

    private fun show(index: Int) = segments.forEachIndexed { i, segment ->
        segment.background = if (i == index) capsule(Color.WHITE) else null
        segment.elevation = if (i == index) dp(1).toFloat() else 0f
        segment.typeface = if (i == index) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }
}

// ---------------------------------------------------------------------------
// The player's overlay controls
// ---------------------------------------------------------------------------

/** What the overlay drives: a bare ExoPlayer on the step-0 screen, the bridge on the other. */
interface Transport {
    fun togglePlay()
    fun skip(seconds: Double)
    fun seekTo(fraction: Double)
    fun setRate(rate: Double)
    fun enterFullscreen()
}

/** AVPlayerViewController's inline controls, in shape and place. */
@SuppressLint("ViewConstructor")
class TransportControls(context: Context, private val transport: Transport) : FrameLayout(context) {
    private val main = Handler(Looper.getMainLooper())
    private val panel = FrameLayout(context)
    private val play = Glyph(context, Glyph.Kind.PLAY)
    private val scrubber = Scrubber(context) { transport.seekTo(it) }
    private var playing = false
    private var rate = 1.0
    private val hide = Runnable { setShown(false) }

    init {
        // Top left: the full-screen pill (where iOS also has AirPlay; casting is off for native playback).
        val top = LinearLayout(context).apply {
            background = capsule(Ios.CONTROL)
            setPadding(dp(6), 0, dp(6), 0)
            addView(Glyph(context, Glyph.Kind.EXPAND).tap { transport.enterFullscreen() }, LinearLayout.LayoutParams(dp(38), dp(38)))
        }
        panel.addView(top, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START).margins(dp(8)))

        val center = LinearLayout(context).apply {
            gravity = Gravity.CENTER
            addView(circle(Glyph(context, Glyph.Kind.BACK_10).tap { transport.skip(-10.0) }, 50))
            addView(View(context), LinearLayout.LayoutParams(dp(22), 1))
            addView(circle(play.tap { transport.togglePlay() }, 68))
            addView(View(context), LinearLayout.LayoutParams(dp(22), 1))
            addView(circle(Glyph(context, Glyph.Kind.FORWARD_10).tap { transport.skip(10.0) }, 50))
        }
        panel.addView(center, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER))

        val bottom = LinearLayout(context).apply {
            background = capsule(Ios.CONTROL)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), 0, dp(6), 0)
            addView(scrubber, LinearLayout.LayoutParams(0, dp(38), 1f))
            addView(Glyph(context, Glyph.Kind.SPEED).tap { chooseRate(it) }, LinearLayout.LayoutParams(dp(38), dp(38)))
        }
        panel.addView(bottom, LayoutParams(MATCH_PARENT, dp(38), Gravity.BOTTOM).margins(dp(8)))

        addView(panel, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setOnClickListener { setShown(panel.visibility != VISIBLE) }
    }

    /** What the engine says now; the controls fade while playing and stay while paused. */
    fun update(playing: Boolean, position: Double, duration: Double?, buffered: Double) {
        if (playing != this.playing) {
            this.playing = playing
            play.kind = if (playing) Glyph.Kind.PAUSE else Glyph.Kind.PLAY
            if (playing) scheduleHide() else setShown(true)
        }
        scrubber.show(position, duration, buffered)
    }

    private fun chooseRate(anchor: View) {
        PopupMenu(context, anchor).apply {
            RATES.forEach { value -> menu.add(if (value == rate) "✓ ${value}×" else "${value}×") }
            setOnMenuItemClickListener { item ->
                rate = RATES[menu.children().indexOf(item)]
                transport.setRate(rate)
                true
            }
        }.show()
    }

    private fun android.view.Menu.children() = (0 until size()).map { getItem(it) }

    private fun setShown(shown: Boolean) {
        main.removeCallbacks(hide)
        panel.animate().cancel()
        if (shown) {
            panel.visibility = VISIBLE
            panel.animate().alpha(1f).setDuration(150).start()
            if (playing) scheduleHide()
        } else {
            panel.animate().alpha(0f).setDuration(250).withEndAction { panel.visibility = GONE }.start()
        }
    }

    private fun scheduleHide() {
        main.removeCallbacks(hide)
        main.postDelayed(hide, 3000)
    }

    private fun circle(glyph: Glyph, size: Int) = FrameLayout(context).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Ios.CONTROL)
        }
        addView(glyph, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
    }

    /** Taps keep the controls up. */
    private fun Glyph.tap(action: (View) -> Unit) = apply {
        isClickable = true
        setOnClickListener {
            action(it)
            if (playing) scheduleHide()
        }
    }

    private fun LayoutParams.margins(margin: Int) = apply { setMargins(margin, margin, margin, margin) }

    private companion object {
        val RATES = listOf(0.5, 1.0, 1.25, 1.5, 2.0)
    }
}

/** The inline scrubber: played white over buffered grey over the track; drag to seek. */
@SuppressLint("ViewConstructor")
class Scrubber(context: Context, private val onSeek: (Double) -> Unit) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var played = 0f
    private var buffered = 0f
    private var dragging: Float? = null

    fun show(position: Double, duration: Double?, bufferedEnd: Double) {
        if (duration == null || duration <= 0) return
        played = (position / duration).toFloat().coerceIn(0f, 1f)
        buffered = (bufferedEnd / duration).toFloat().coerceIn(0f, 1f)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val height = context.dp(if (dragging != null) 10 else 7).toFloat()
        val top = (this.height - height) / 2
        val radius = height / 2
        val width = width.toFloat()
        fun bar(fraction: Float, color: Int) {
            paint.color = color
            canvas.drawRoundRect(RectF(0f, top, width * fraction, top + height), radius, radius, paint)
        }
        bar(1f, 0xFF5B5B5F.toInt())
        bar(buffered, 0xFF8A8A8E.toInt())
        bar(dragging ?: played, Color.WHITE)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val fraction = (event.x / width).coerceIn(0f, 1f)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                parent.requestDisallowInterceptTouchEvent(true)
                dragging = fraction
            }
            MotionEvent.ACTION_UP -> {
                dragging = null
                played = fraction
                onSeek(fraction.toDouble())
            }
            MotionEvent.ACTION_CANCEL -> dragging = null
        }
        invalidate()
        return true
    }
}

/** The SF Symbols the iOS controls use, drawn rather than bundled. */
@SuppressLint("ViewConstructor")
class Glyph(context: Context, kind: Kind) : View(context) {
    enum class Kind { PLAY, PAUSE, BACK_10, FORWARD_10, EXPAND, SPEED }

    var kind = kind
        set(value) {
            field = value
            invalidate()
        }

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height).toFloat()
        val cx = width / 2f
        val cy = height / 2f
        fun x(f: Float) = cx + (f - 0.5f) * s
        fun y(f: Float) = cy + (f - 0.5f) * s
        when (kind) {
            Kind.PLAY -> {
                fill.pathEffect = CornerPathEffect(s * 0.05f)
                canvas.drawPath(Path().apply {
                    moveTo(x(0.38f), y(0.29f))
                    lineTo(x(0.38f), y(0.71f))
                    lineTo(x(0.72f), y(0.5f))
                    close()
                }, fill)
                fill.pathEffect = null
            }
            Kind.PAUSE -> {
                val r = s * 0.03f
                canvas.drawRoundRect(RectF(x(0.34f), y(0.30f), x(0.45f), y(0.70f)), r, r, fill)
                canvas.drawRoundRect(RectF(x(0.55f), y(0.30f), x(0.66f), y(0.70f)), r, r, fill)
            }
            Kind.BACK_10, Kind.FORWARD_10 -> {
                val back = kind == Kind.BACK_10
                val r = s * 0.27f
                stroke.strokeWidth = s * 0.055f
                val oval = RectF(cx - r, cy - r, cx + r, cy + r)
                // A ring open at the top, its arrow pointing into the gap.
                if (back) canvas.drawArc(oval, -80f, 300f, false, stroke) else canvas.drawArc(oval, -100f, -300f, false, stroke)
                val tip = if (back) cx - s * 0.11f else cx + s * 0.11f
                val base = if (back) cx + s * 0.01f else cx - s * 0.01f
                canvas.drawPath(Path().apply {
                    moveTo(tip, cy - r)
                    lineTo(base, cy - r - s * 0.08f)
                    lineTo(base, cy - r + s * 0.08f)
                    close()
                }, fill)
                text.textSize = s * 0.25f
                canvas.drawText("10", cx, cy - (text.descent() + text.ascent()) / 2, text)
            }
            Kind.EXPAND -> {
                stroke.strokeWidth = s * 0.055f
                fun arrow(fromX: Float, fromY: Float, toX: Float, toY: Float) {
                    canvas.drawLine(x(fromX), y(fromY), x(toX), y(toY), stroke)
                    val dx = if (toX > fromX) -0.15f else 0.15f
                    val dy = if (toY > fromY) -0.15f else 0.15f
                    canvas.drawLine(x(toX), y(toY), x(toX + dx), y(toY), stroke)
                    canvas.drawLine(x(toX), y(toY), x(toX), y(toY + dy), stroke)
                }
                arrow(0.44f, 0.44f, 0.26f, 0.26f)
                arrow(0.56f, 0.56f, 0.74f, 0.74f)
            }
            Kind.SPEED -> {
                stroke.strokeWidth = s * 0.05f
                val r = s * 0.30f
                canvas.drawCircle(cx, cy, r, stroke)
                stroke.strokeWidth = s * 0.035f
                for (degrees in listOf(-210, -165, -120, -75, -30)) {
                    val a = Math.toRadians(degrees.toDouble())
                    canvas.drawLine(
                        cx + (r * 0.62f * cos(a)).toFloat(), cy + (r * 0.62f * sin(a)).toFloat(),
                        cx + (r * 0.78f * cos(a)).toFloat(), cy + (r * 0.78f * sin(a)).toFloat(), stroke,
                    )
                }
                val needle = Math.toRadians(-50.0)
                stroke.strokeWidth = s * 0.05f
                canvas.drawLine(cx, cy, cx + (r * 0.6f * cos(needle)).toFloat(), cy + (r * 0.6f * sin(needle)).toFloat(), stroke)
                canvas.drawCircle(cx, cy, s * 0.04f, fill)
            }
        }
    }
}
