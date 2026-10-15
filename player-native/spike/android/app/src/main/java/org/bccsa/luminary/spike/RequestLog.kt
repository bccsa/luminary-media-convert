package org.bccsa.luminary.spike

import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.hls.HlsDataSourceFactory
import java.io.IOException
import org.bccsa.luminary.player.UriRouter

/**
 * Every request ExoPlayer makes through the plugin's [UriRouter]: each `luminary://` answer in
 * full, the first few segment requests, and a tally of bytes by whether the transfer counted as
 * network (which is what the bandwidth estimate reads). Called from ExoPlayer's loader threads.
 */
@OptIn(UnstableApi::class)
class RequestLog(private val log: (String) -> Unit) {
    private var memoryOpens = 0
    private var memoryBytes = 0L
    private var networkOpens = 0
    private var rangedOpens = 0
    private var networkBytes = 0L
    private var segmentsLogged = 0

    val listener = object : TransferListener {
        override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytes: Int) {
            synchronized(this@RequestLog) {
                if (isNetwork) networkBytes += bytes else memoryBytes += bytes
            }
        }
    }

    @Synchronized
    fun begin() {
        memoryOpens = 0
        memoryBytes = 0
        networkOpens = 0
        rangedOpens = 0
        networkBytes = 0
        segmentsLogged = 0
    }

    @Synchronized
    fun summary(): String =
        "memory=$memoryBytes B in $memoryOpens opens, network=$networkBytes B in $networkOpens opens ($rangedOpens ranged)"

    /** Wraps the router, so what the engine asks for is logged on the way through. */
    fun wrap(router: UriRouter): HlsDataSourceFactory =
        HlsDataSourceFactory { dataType -> LoggingDataSource(router.createDataSource(dataType), dataType) }

    @Synchronized
    private fun opened(spec: DataSpec, dataType: Int, length: Long, ms: Long) {
        val uri = spec.uri.toString()
        if (uri.startsWith("luminary://")) {
            memoryOpens++
            log("loader  $uri -> $length B, type=${typeName(dataType)}, range=${range(spec)}, in $ms ms")
            return
        }
        networkOpens++
        if (spec.position != 0L || spec.length != C.LENGTH_UNSET.toLong()) rangedOpens++
        if (segmentsLogged++ < SEGMENTS_TO_LOG) {
            log("http    ${spec.uri.path} range=${range(spec)} type=${typeName(dataType)} open in $ms ms")
        }
    }

    private fun failed(spec: DataSpec, error: IOException) =
        log("loader  ${spec.uri} FAILED ${error.javaClass.simpleName}: ${error.message}")

    private inner class LoggingDataSource(private val inner: DataSource, private val dataType: Int) : DataSource {
        init {
            inner.addTransferListener(listener)
        }

        override fun addTransferListener(transferListener: TransferListener) = inner.addTransferListener(transferListener)

        override fun open(dataSpec: DataSpec): Long {
            val started = SystemClock.elapsedRealtime()
            return try {
                inner.open(dataSpec).also { opened(dataSpec, dataType, it, SystemClock.elapsedRealtime() - started) }
            } catch (error: IOException) {
                failed(dataSpec, error)
                throw error
            }
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int) = inner.read(buffer, offset, length)
        override fun getUri() = inner.uri
        override fun getResponseHeaders() = inner.responseHeaders
        override fun close() = inner.close()
    }

    private companion object {
        const val SEGMENTS_TO_LOG = 6

        fun range(spec: DataSpec) =
            if (spec.position == 0L && spec.length == C.LENGTH_UNSET.toLong()) "all"
            else "${spec.position}+${if (spec.length == C.LENGTH_UNSET.toLong()) "rest" else spec.length}"

        fun typeName(dataType: Int) = when (dataType) {
            C.DATA_TYPE_MANIFEST -> "manifest"
            C.DATA_TYPE_MEDIA -> "media"
            C.DATA_TYPE_MEDIA_INITIALIZATION -> "init"
            C.DATA_TYPE_DRM -> "key"
            else -> "unknown($dataType)"
        }
    }
}
