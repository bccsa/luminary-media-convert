package org.bccsa.luminary.player.engine

/**
 * What the full-screen controls say to a screen reader and in their menus: `player-web`'s
 * `messages.ts` defaults, with the labels video.js supplies itself for the controls `messages.ts`
 * has none for. The host sends its translated strings each time full-screen opens; any it does not
 * send stay English.
 */
data class FullscreenTexts(
    val play: String = "Play",
    val pause: String = "Pause",
    val seek: String = "Seek",
    /** `{seconds}` is the interval. */
    val skipBack: String = "Skip back {seconds} seconds",
    val skipForward: String = "Skip forward {seconds} seconds",
    val exitFullscreen: String = "Exit full screen",
    val audioMenu: String = "Audio",
    val subtitlesMenu: String = "Subtitles",
    val subtitlesOff: String = "Off",
    val pictureInPicture: String = "Picture-in-Picture",
    val playbackRate: String = "Playback Rate",
    val mute: String = "Mute",
    val unmute: String = "Unmute",
    val loading: String = "Loading",
) {
    fun skipBack(seconds: Int) = skipBack.replace("{seconds}", seconds.toString())

    fun skipForward(seconds: Int) = skipForward.replace("{seconds}", seconds.toString())

    companion object {
        /** The defaults, with each string the host sent put over its own. */
        fun from(sent: Map<String, String>): FullscreenTexts {
            val base = FullscreenTexts()
            return FullscreenTexts(
                play = sent["play"] ?: base.play,
                pause = sent["pause"] ?: base.pause,
                seek = sent["seek"] ?: base.seek,
                skipBack = sent["skipBack"] ?: base.skipBack,
                skipForward = sent["skipForward"] ?: base.skipForward,
                exitFullscreen = sent["exitFullscreen"] ?: base.exitFullscreen,
                audioMenu = sent["audioMenu"] ?: base.audioMenu,
                subtitlesMenu = sent["subtitlesMenu"] ?: base.subtitlesMenu,
                subtitlesOff = sent["subtitlesOff"] ?: base.subtitlesOff,
                pictureInPicture = sent["pictureInPicture"] ?: base.pictureInPicture,
                playbackRate = sent["playbackRate"] ?: base.playbackRate,
                mute = sent["mute"] ?: base.mute,
                unmute = sent["unmute"] ?: base.unmute,
                loading = sent["loading"] ?: base.loading,
            )
        }
    }
}
