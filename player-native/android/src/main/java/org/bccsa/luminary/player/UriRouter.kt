package org.bccsa.luminary.player

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.hls.HlsDataSourceFactory
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.min
import okhttp3.OkHttpClient

/**
 * The bridge's URI scheme (`luminary://asset | key`), and the engine's way to everything else.
 * ExoPlayer gets a routing [DataSource] per `open()`, chosen by URI and never by `dataType`.
 */
@OptIn(UnstableApi::class)
class UriRouter(
    private val assets: AssetStore,
    private val key: KeyHolder,
    private val upstream: HttpUpstream?,
) : HlsDataSourceFactory {
    sealed interface Route {
        class Served(val bytes: ByteArray, val contentType: String) : Route

        /** `not-found` or `key-required`. */
        data class Failed(val code: String) : Route
    }

    /** What the bridge answers from memory; anything else is not the bridge's to answer. */
    fun route(uri: String): Route {
        if (uri == KEY_URI) {
            val bytes = key.copy() ?: return Route.Failed("key-required")
            return Route.Served(bytes, "application/octet-stream")
        }
        if (uri.startsWith(ASSET_URI_PREFIX)) {
            val asset = assets.get(uri) ?: return Route.Failed("not-found")
            return Route.Served(asset.bytes, asset.contentType)
        }
        return Route.Failed("not-found")
    }

    override fun createDataSource(dataType: Int): DataSource = RoutingDataSource(this)

    internal fun sourceFor(dataSpec: DataSpec): DataSource {
        val uri = dataSpec.uri.toString()
        if (uri.startsWith("luminary://")) {
            return when (val route = route(uri)) {
                is Route.Served -> MemoryDataSource(route.bytes)
                is Route.Failed ->
                    if (route.code == "key-required") throw KeyRequiredException() else throw AssetNotFoundException(uri)
            }
        }
        val http = upstream ?: throw AssetNotFoundException(uri)
        val isByteRange = dataSpec.position != 0L || dataSpec.length != C.LENGTH_UNSET.toLong()
        return (if (isByteRange) http.byteRange else http.plain).createDataSource()
    }
}

/** A missing asset is never retried: the load policy treats a [FileNotFoundException] as final. */
class AssetNotFoundException(uri: String) : FileNotFoundException(uri)

/** `luminary://key` requested with no key set. */
class KeyRequiredException : IOException("key-required")

/**
 * The app's one [OkHttpClient], behind the two factories [UriRouter] falls through to for `https`.
 * Byte-range requests get the longer read timeout: every rendition of an angle shares one chunk
 * object, so a slow first byte means a cold edge, not too little bandwidth (see the caution in
 * `docs/suspension-safe-playback.md`).
 */
@OptIn(UnstableApi::class)
class HttpUpstream(client: OkHttpClient) {
    val plain: DataSource.Factory = OkHttpDataSource.Factory(client)
    val byteRange: DataSource.Factory = OkHttpDataSource.Factory(
        client.newBuilder().readTimeout(BYTE_RANGE_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).build(),
    )

    companion object {
        /** The web's backstop (`vhsRequestTimeout.ts`) at this encoder's default 6 s segments. */
        const val BYTE_RANGE_READ_TIMEOUT_SECONDS = 60L
    }
}

@OptIn(UnstableApi::class)
private class RoutingDataSource(private val router: UriRouter) : DataSource {
    private val listeners = mutableListOf<TransferListener>()
    private var delegate: DataSource? = null

    override fun addTransferListener(transferListener: TransferListener) {
        listeners += transferListener
    }

    override fun open(dataSpec: DataSpec): Long {
        val source = router.sourceFor(dataSpec)
        listeners.forEach(source::addTransferListener)
        delegate = source
        return source.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        checkNotNull(delegate) { "read before open" }.read(buffer, offset, length)

    override fun getUri(): Uri? = delegate?.uri

    override fun getResponseHeaders(): Map<String, List<String>> = delegate?.responseHeaders ?: emptyMap()

    override fun close() {
        try {
            delegate?.close()
        } finally {
            delegate = null
        }
    }
}

/** In-memory answers are not network transfers, so they never reach the bandwidth estimate. */
@OptIn(UnstableApi::class)
private class MemoryDataSource(private val data: ByteArray) : BaseDataSource(/* isNetwork= */ false) {
    private var uri: Uri? = null
    private var position = 0
    private var remaining = 0
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        if (dataSpec.position > data.size) {
            throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
        }
        position = dataSpec.position.toInt()
        remaining = data.size - position
        if (dataSpec.length != C.LENGTH_UNSET.toLong()) remaining = min(remaining.toLong(), dataSpec.length).toInt()
        opened = true
        transferStarted(dataSpec)
        return remaining.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0) return C.RESULT_END_OF_INPUT
        val count = min(length, remaining)
        System.arraycopy(data, position, buffer, offset, count)
        position += count
        remaining -= count
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        if (opened) {
            opened = false
            transferEnded()
        }
        uri = null
    }
}
