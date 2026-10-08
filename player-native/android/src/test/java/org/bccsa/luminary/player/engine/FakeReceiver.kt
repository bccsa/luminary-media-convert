package org.bccsa.luminary.player.engine

import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/** A TV's player as the engine sees it, which does what it is told and downloads nothing. */
@UnstableApi
class FakeReceiver : SimpleBasePlayer(Looper.getMainLooper()) {
    var items: List<MediaItem> = emptyList()
        private set
    private var wanted = false
    private var position = 0L
    private var phase = Player.STATE_IDLE
    private var speed = 1f
    private var failure: PlaybackException? = null
    var stops = 0
        private set

    /** The first item's address, which is what the TV would fetch. */
    val uri: String? get() = items.firstOrNull()?.localConfiguration?.uri?.toString()

    /** The TV's own state moving, as it would on its own. */
    fun reach(position: Long, playing: Boolean) {
        this.position = position
        wanted = playing
        phase = Player.STATE_READY
        invalidateState()
    }

    fun fail() {
        failure = PlaybackException("receiver", null, PlaybackException.ERROR_CODE_REMOTE_ERROR)
        phase = Player.STATE_IDLE
        invalidateState()
    }

    override fun getState(): State {
        val playlist = items.map {
            MediaItemData.Builder(it).setDurationUs(60_000_000L).build()
        }
        return State.Builder()
            .setAvailableCommands(
                Player.Commands.Builder()
                    .addAll(
                        Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP, Player.COMMAND_SET_SPEED_AND_PITCH,
                        Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                        Player.COMMAND_GET_TIMELINE, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_RELEASE,
                    )
                    .build(),
            )
            .setPlayWhenReady(wanted, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(if (items.isEmpty()) Player.STATE_IDLE else phase)
            .setPlaylist(ImmutableList.copyOf(playlist))
            .setContentPositionMs(position)
            .setPlaybackParameters(PlaybackParameters(speed))
            .setPlayerError(failure)
            .build()
    }

    override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
        items = mediaItems.toList()
        position = if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs
        return Futures.immediateVoidFuture()
    }

    override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int): ListenableFuture<*> {
        items = emptyList()
        return Futures.immediateVoidFuture()
    }

    override fun handlePrepare(): ListenableFuture<*> {
        phase = Player.STATE_READY
        failure = null
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        wanted = playWhenReady
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        position = positionMs
        return Futures.immediateVoidFuture()
    }

    override fun handleSetPlaybackParameters(playbackParameters: PlaybackParameters): ListenableFuture<*> {
        speed = playbackParameters.speed
        return Futures.immediateVoidFuture()
    }

    override fun handleStop(): ListenableFuture<*> {
        stops++
        phase = Player.STATE_IDLE
        return Futures.immediateVoidFuture()
    }

    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()
}
