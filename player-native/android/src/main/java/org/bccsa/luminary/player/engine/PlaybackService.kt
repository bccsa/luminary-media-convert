package org.bccsa.luminary.player.engine

import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Hosts the engine's [MediaSession], which is what keeps playback going with the screen locked:
 * Media3 runs this service in the foreground, with the media notification, while the player plays.
 * The engine owns the player and the session; this only carries them through the background.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    override fun onCreate() {
        super.onCreate()
        running = this
        session?.let(::addSession)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiping the app away ends playback with it, rather than leaving sound with no app behind it. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        session?.player?.pause()
        stopSelf()
    }

    override fun onDestroy() {
        if (running === this) running = null
        super.onDestroy()
    }

    companion object {
        /** The one session to host: `maxPlayers` is 1. */
        private var session: MediaSession? = null
        private var running: PlaybackService? = null

        /** Starts the service for [session]. Called from a load, while the app is in the foreground. */
        fun host(context: Context, session: MediaSession) {
            if (this.session === session) return
            this.session = session
            val service = running
            if (service != null) {
                service.addSession(session)
            } else {
                context.startService(Intent(context, PlaybackService::class.java))
            }
        }

        /** The session is released; with nothing left to host, the service goes. */
        fun release(session: MediaSession) {
            if (this.session !== session) return
            this.session = null
            running?.let {
                it.removeSession(session)
                it.stopSelf()
            }
        }
    }
}
