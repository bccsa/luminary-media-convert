package org.bccsa.luminary.player

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore

/**
 * A minimal HTTP server on the phone for the length of a cast. A Cast receiver fetches the stream
 * itself, and the playlists and key it needs live in memory behind `luminary://`: this answers for
 * them, with the playlists' addresses rewritten (see [rewriteForCast]). Segments are not served here.
 *
 * Everything is behind a per-session [token], and only what [router] already holds for the current
 * load can be asked for: a request is mapped to a bridge address, and the router either has it or
 * does not. Never log the token or a response: the token is the key's address, a response may be the key.
 *
 * `GET`, `HEAD` and `OPTIONS`, with the CORS headers a web receiver's `XMLHttpRequest` needs.
 */
class CastServer(
    private val router: UriRouter,
    /** The Wi-Fi address to listen on, never a wildcard: see [lanAddress]. */
    private val address: InetAddress,
    val token: String = newToken(),
) : AutoCloseable {
    private var server: ServerSocket? = null
    private var executor: ExecutorService? = null
    private val connections = Collections.synchronizedSet(HashSet<Socket>())
    private val slots = Semaphore(MAX_CONNECTIONS)

    /** `http://<address>:<port>/<token>`, the base the rewritten playlists name. Valid once [start] has returned. */
    lateinit var base: String
        private set

    @Synchronized
    fun start(): String {
        check(server == null) { "already started" }
        val socket = ServerSocket(0, BACKLOG, address)
        server = socket
        executor = Executors.newFixedThreadPool(WORKERS) { Thread(it, "cast-server-worker").apply { isDaemon = true } }
        base = "http://${address.hostAddress}:${socket.localPort}/$token"
        Thread({ accept(socket) }, "cast-server-accept").apply { isDaemon = true }.start()
        return base
    }

    @Synchronized
    override fun close() {
        server?.close()
        server = null
        executor?.shutdownNow()
        executor = null
        synchronized(connections) { connections.forEach { runCatching(it::close) } }
        connections.clear()
    }

    private fun accept(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (closed: SocketException) {
                return
            } catch (io: IOException) {
                continue
            }
            if (!slots.tryAcquire()) {
                // Full: say so rather than queue without end.
                runCatching { respond(client.getOutputStream(), 503, "Service Unavailable") }
                runCatching(client::close)
                continue
            }
            connections += client
            try {
                executor?.execute { serve(client) } ?: client.close()
            } catch (rejected: RejectedExecutionException) {
                client.close()
            }
        }
    }

    private fun serve(client: Socket) {
        try {
            client.soTimeout = SOCKET_TIMEOUT_MS
            handle(client.getInputStream(), client.getOutputStream())
        } catch (ignored: IOException) {
            // A client that goes away mid-answer is none of our business.
        } finally {
            connections -= client
            slots.release()
            runCatching(client::close)
        }
    }

    private fun handle(input: InputStream, output: OutputStream) {
        val head = readHead(input) ?: return respond(output, 431, "Request Header Fields Too Large")
        val lines = head.split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size != 3) return respond(output, 400, "Bad Request")
        val (method, target) = parts
        val headers = lines.drop(1).filter { ':' in it }.associate {
            it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim()
        }

        if (method == "OPTIONS") return respond(output, 204, "No Content", cors = true)
        if (method != "GET" && method != "HEAD") return respond(output, 405, "Method Not Allowed", cors = true)

        // A query or a fragment names nothing here.
        val path = target.substringBefore('?').substringBefore('#')
        // `v`: the variant a quality pin keeps, on the master only.
        val pin = target.substringAfter('?', "").substringBefore('#').split('&')
            .firstOrNull { it.startsWith("v=") }?.removePrefix("v=")?.takeIf { it.matches(VARIANT_ID) }
        val prefix = "/$token"
        // Constant time on the token, so a LAN neighbour cannot learn it a character at a time.
        val given = path.removePrefix("/").substringBefore('/')
        if (!path.startsWith("/") || !MessageDigest.isEqual(given.toByteArray(), token.toByteArray())) {
            Log.w(TAG, "$method request with a wrong token from the receiver or a neighbour")
            return respond(output, 404, "Not Found", cors = true)
        }
        val uri = bridgeUriOf(path.removePrefix(prefix)) ?: return respond(output, 404, "Not Found", cors = true)

        // Only the part after the token is logged; the token itself never is.
        val shown = path.removePrefix(prefix)
        when (val answer = answer(uri, pin)) {
            is Answer.Body -> {
                Log.d(TAG, "$method $shown range=${headers["range"]} -> ${answer.bytes.size} bytes")
                send(output, method == "HEAD", answer.bytes, answer.type, headers["range"])
            }
            Answer.Missing -> {
                Log.w(TAG, "$method $shown -> 404 (not held)")
                respond(output, 404, "Not Found", cors = true)
            }
            Answer.Upstream -> {
                Log.w(TAG, "$method $shown -> 502 (origin refused the live playlist)")
                respond(output, 502, "Bad Gateway", cors = true)
            }
        }
    }

    private sealed interface Answer {
        class Body(val bytes: ByteArray, val type: String) : Answer

        /** The router does not hold it (or no longer does): the key was zeroed, the generation purged. */
        data object Missing : Answer

        /** A live playlist the origin would not give. */
        data object Upstream : Answer
    }

    private fun answer(uri: String, pin: String?): Answer = when (val route = router.route(uri)) {
        is UriRouter.Route.Served ->
            if (isText(route.contentType)) {
                val text = String(route.bytes, Charsets.UTF_8).let { if (pin != null) pinVariant(it, pin) else it }
                Answer.Body(rewriteForCast(text, base).toByteArray(Charsets.UTF_8), route.contentType)
            } else {
                Answer.Body(route.bytes, route.contentType)
            }
        is UriRouter.Route.Live -> try {
            Answer.Body(rewriteForCast(router.readLive(route.spec), base).toByteArray(Charsets.UTF_8), PLAYLIST_TYPE)
        } catch (failure: LiveFailure) {
            Answer.Upstream
        }
        is UriRouter.Route.Failed, UriRouter.Route.Unanswered -> Answer.Missing
    }

    private fun send(output: OutputStream, headOnly: Boolean, bytes: ByteArray, type: String, range: String?) {
        val match = range?.let(RANGE::matchEntire)
        if (match != null) {
            val start = match.groupValues[1].toInt()
            val end = match.groupValues[2].takeIf { it.isNotEmpty() }?.toInt()?.coerceAtMost(bytes.size - 1) ?: (bytes.size - 1)
            if (start >= bytes.size || start > end) {
                return respond(output, 416, "Range Not Satisfiable", cors = true, extra = "Content-Range: bytes */${bytes.size}\r\n")
            }
            val slice = bytes.copyOfRange(start, end + 1)
            return respond(
                output, 206, "Partial Content", cors = true, type = type, body = if (headOnly) null else slice, length = slice.size,
                extra = "Content-Range: bytes $start-$end/${bytes.size}\r\n",
            )
        }
        respond(output, 200, "OK", cors = true, type = type, body = if (headOnly) null else bytes, length = bytes.size)
    }

    private fun respond(
        output: OutputStream,
        status: Int,
        reason: String,
        cors: Boolean = false,
        type: String? = null,
        body: ByteArray? = null,
        length: Int = body?.size ?: 0,
        extra: String = "",
    ) {
        val head = StringBuilder("HTTP/1.1 $status $reason\r\n")
        if (cors) {
            head.append("Access-Control-Allow-Origin: *\r\n")
            head.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
            head.append("Access-Control-Allow-Headers: Range\r\n")
            head.append("Access-Control-Expose-Headers: Content-Length, Content-Range\r\n")
            head.append("Access-Control-Max-Age: 600\r\n")
        }
        // A live playlist must never be cached, and nothing here is worth caching.
        head.append("Cache-Control: no-store\r\n")
        if (type != null) head.append("Content-Type: $type\r\n")
        head.append(extra)
        head.append("Content-Length: $length\r\n")
        head.append("Connection: close\r\n\r\n")
        output.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        if (body != null) output.write(body)
        output.flush()
    }

    /** The request line and headers, up to the blank line; null when they run past the limit. */
    private fun readHead(input: InputStream): String? {
        val bytes = java.io.ByteArrayOutputStream()
        var matched = 0
        while (bytes.size() <= MAX_HEAD_BYTES) {
            val next = input.read()
            if (next < 0) return null
            bytes.write(next)
            matched = if (next == END_OF_HEAD[matched].code) matched + 1 else if (next == '\r'.code) 1 else 0
            if (matched == END_OF_HEAD.length) return String(bytes.toByteArray(), 0, bytes.size() - 4, Charsets.ISO_8859_1)
        }
        return null
    }

    private fun isText(contentType: String) = "mpegurl" in contentType || contentType.startsWith("text/")

    companion object {
        private const val TAG = "LuminaryCast"
        private val VARIANT_ID = Regex("\\d+_\\d+")

        private const val WORKERS = 4
        private const val MAX_CONNECTIONS = 8
        private const val BACKLOG = 8
        private const val SOCKET_TIMEOUT_MS = 10_000
        private const val MAX_HEAD_BYTES = 8192
        private const val END_OF_HEAD = "\r\n\r\n"
        private const val PLAYLIST_TYPE = "application/vnd.apple.mpegurl"
        private val RANGE = Regex("bytes=(\\d+)-(\\d*)")

        /** 128 random bits, new for every cast. */
        fun newToken(): String = ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

        /**
         * The phone's address on the Wi-Fi (or Ethernet) network, which is the only one a receiver
         * on the same LAN can reach and the only one this should listen on. Null when there is none:
         * a cast does not start then, and the page is not told it has.
         */
        fun lanAddress(): InetAddress? = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
            .filter { it.name.startsWith("wlan") || it.name.startsWith("eth") || it.name.startsWith("ap") }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is java.net.Inet4Address && it.isSiteLocalAddress }
    }
}
