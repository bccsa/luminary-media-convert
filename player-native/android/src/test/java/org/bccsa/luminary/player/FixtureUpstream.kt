package org.bccsa.luminary.player

import java.util.Collections
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer

/**
 * A fake HTTP upstream serving `src/test/resources/<root>/`, honouring `Range` the way a CDN does,
 * and remembering every request it was asked.
 */
class FixtureUpstream(private val root: String) : AutoCloseable {
    val server = MockWebServer()
    val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val bytes = resource(request.path!!.trimStart('/')) ?: return MockResponse().setResponseCode(404)
                val range = request.getHeader("Range")?.let(RANGE::find)
                    ?: return MockResponse().setBody(Buffer().write(bytes))
                val start = range.groupValues[1].toInt()
                val end = range.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: (bytes.size - 1)
                return MockResponse()
                    .setResponseCode(206)
                    .setHeader("Content-Range", "bytes $start-$end/${bytes.size}")
                    .setBody(Buffer().write(bytes.copyOfRange(start, end + 1)))
            }
        }
        server.start()
    }

    val base: String get() = server.url("/").toString().trimEnd('/')

    /** A fixture text file, with `{{BASE}}` pointing at this upstream. */
    fun text(name: String): String = String(resource(name)!!, Charsets.UTF_8).replace("{{BASE}}", base)

    private fun resource(name: String): ByteArray? =
        javaClass.classLoader!!.getResourceAsStream("$root/$name")?.use { it.readBytes() }

    override fun close() = server.shutdown()

    private companion object {
        val RANGE = Regex("^bytes=(\\d+)-(\\d*)$")
    }
}
