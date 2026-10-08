package org.bccsa.luminary.player.engine

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider

/**
 * Our own receiver when the host names its app id (`CAST_RECEIVER_APP_ID`), else Google's Default
 * Media Receiver; never media3's sample one, which never gets the TV remote's keys.
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions =
        CastOptions.Builder()
            .setResumeSavedSession(false)
            .setEnableReconnectionService(false)
            .setReceiverApplicationId(
                GoogleCastSupport.receiverAppId(context) ?: CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID,
            )
            .setStopReceiverApplicationWhenEndingSession(true)
            .build()

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
