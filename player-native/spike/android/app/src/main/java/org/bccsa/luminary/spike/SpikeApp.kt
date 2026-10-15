package org.bccsa.luminary.spike

import android.app.Application
import android.util.Log

/** Owns the bundled stream's server, so every screen shares the one address its payload names. */
class SpikeApp : Application() {
    var server: LocalStreamServer? = null
        private set

    override fun onCreate() {
        super.onCreate()
        if (LocalStreamServer.bundled(assets)) {
            server = runCatching {
                LocalStreamServer(assets, LocalStreamServer.PORT) { Log.i(TAG, it) }.also { it.start() }
            }.onFailure { Log.e(TAG, "server could not start", it) }.getOrNull()
        }
    }

    companion object {
        const val TAG = "LmcSpike"
    }
}
