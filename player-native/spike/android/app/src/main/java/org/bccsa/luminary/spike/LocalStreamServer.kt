package org.bccsa.luminary.spike

import android.content.res.AssetManager
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Serves the bundled sample stream (`assets/stream/`, from `make-sample-stream.py`) on
 * `http://127.0.0.1:<port>`, the address its payload was recorded against, honouring `Range` the
 * way a CDN does. Loopback is never a cold edge: timings here are the best case, not a CDN's.
 */
class LocalStreamServer(
    private val assets: AssetManager,
    private val port: Int,
    private val log: (String) -> Unit,
) {
    private val socket = ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"))
    private val workers = Executors.newCachedThreadPool()

    fun start() {
        thread(name = "spike-stream-server", isDaemon = true) {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: IOException) {
                    break
                }
                workers.execute { serve(client) }
            }
        }
        log("server  bundled stream on http://127.0.0.1:$port")
    }

    fun stop() {
        socket.close()
        workers.shutdownNow()
    }

    private fun serve(client: Socket) = client.use {
        try {
            val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.US_ASCII))
            val request = reader.readLine()?.split(" ") ?: return
            val headers = generateSequence { reader.readLine()?.takeIf { it.isNotEmpty() } }
                .mapNotNull { line -> line.split(":", limit = 2).takeIf { it.size == 2 } }
                .associate { (key, value) -> key.trim().lowercase() to value.trim() }
            val method = request[0]
            val path = URI(request.getOrElse(1) { "/" }).path.trimStart('/')
            val out = client.getOutputStream()
            if (path.isEmpty() || ".." in path) return respond(out, 404, "Not Found")

            val file = try {
                assets.openFd("$ROOT/$path")
            } catch (_: IOException) {
                return respond(out, 404, "Not Found")
            }
            file.use {
                val size = file.length
                val range = headers["range"]?.let(RANGE::find)
                val start = range?.groupValues?.get(1)?.toLong() ?: 0L
                val end = range?.groupValues?.get(2)?.takeIf { it.isNotEmpty() }?.toLong()?.coerceAtMost(size - 1)
                    ?: (size - 1)
                if (start > end) return respond(out, 416, "Range Not Satisfiable")
                val length = end - start + 1

                val head = buildString {
                    append(if (range != null) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
                    append("Content-Type: ${contentType(path)}\r\n")
                    append("Content-Length: $length\r\n")
                    append("Accept-Ranges: bytes\r\n")
                    if (range != null) append("Content-Range: bytes $start-$end/$size\r\n")
                    append("Connection: close\r\n\r\n")
                }
                out.write(head.toByteArray(Charsets.US_ASCII))
                if (method != "HEAD") {
                    file.createInputStream().use { input ->
                        var skipped = 0L
                        while (skipped < start) skipped += input.skip(start - skipped)
                        val buffer = ByteArray(64 * 1024)
                        var remaining = length
                        while (remaining > 0) {
                            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                            if (count < 0) break
                            out.write(buffer, 0, count)
                            remaining -= count
                        }
                    }
                }
                out.flush()
            }
        } catch (_: IOException) {
            // The player closed the connection (a seek, or a switch); nothing to answer.
        }
    }

    private fun respond(out: OutputStream, status: Int, reason: String) {
        out.write("HTTP/1.1 $status $reason\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
        out.flush()
    }

    companion object {
        const val PORT = 8765
        private const val ROOT = "stream"
        private val RANGE = Regex("^bytes=(\\d+)-(\\d*)$")

        fun bundled(assets: AssetManager): Boolean =
            runCatching { assets.list(ROOT)?.contains("master.m3u8") == true }.getOrDefault(false)

        private fun contentType(path: String) = when (path.substringAfterLast('.')) {
            "m3u8" -> "application/vnd.apple.mpegurl"
            "mp4" -> "video/mp4"
            else -> "video/iso.segment"
        }
    }
}
