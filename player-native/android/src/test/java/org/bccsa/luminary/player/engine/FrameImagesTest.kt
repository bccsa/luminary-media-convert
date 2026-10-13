package org.bccsa.luminary.player.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What counts as one of the app's own files, and so is read from the package rather than fetched. */
@RunWith(RobolectricTestRunner::class)
class FrameImagesTest {
    @Test
    fun `a path on the app's own origin is one of its files`() {
        assertTrue(FrameImages.isAppPath("/assets/georgia-CFhkCDWf.webp"))
    }

    @Test
    fun `an address or a protocol-relative one is not`() {
        assertFalse(FrameImages.isAppPath("https://images.example/a.webp"))
        assertFalse(FrameImages.isAppPath("//images.example/a.webp"))
        assertFalse(FrameImages.isAppPath("data:image/png;base64,AAAA"))
    }
}
