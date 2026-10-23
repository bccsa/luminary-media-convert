package org.bccsa.luminary.player.engine

/** Glyphs for the chapters / up-next panel, drawn on [V10Icons]' 18-unit grid in the same layers. */
internal object BrowseIcons {
    /** Three rows, each a bullet and a line. */
    val list = listOf(
        V10Icons.Layer("M3 3.25a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", 1f, 0f),
        V10Icons.Layer("M3 7.75a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", 1f, 0f),
        V10Icons.Layer("M3 12.25a1.25 1.25 0 1 0 0 2.5a1.25 1.25 0 1 0 0-2.5z", 1f, 0f),
        V10Icons.Layer("M7.5 3.6h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", 1f, 0f),
        V10Icons.Layer("M7.5 8.1h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", 1f, 0f),
        V10Icons.Layer("M7.5 12.6h8a.9.9 0 0 1 0 1.8h-8a.9.9 0 0 1 0-1.8z", 1f, 0f),
    )

    val close = listOf(
        V10Icons.Layer("M4.5 4.5l9 9M13.5 4.5l-9 9", 1f, 2f),
    )
}
