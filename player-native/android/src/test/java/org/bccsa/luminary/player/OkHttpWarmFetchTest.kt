package org.bccsa.luminary.player

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test

class OkHttpWarmFetchTest {
    private var requests = 0
    private val client = OkHttpClient.Builder()
        .addInterceptor(Interceptor { chain ->
            requests++
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(206)
                .message("Partial Content")
                .body(ByteArray(0).toResponseBody())
                .build()
        })
        .build()

    private fun awaitIdle() = client.dispatcher.executorService.let {
        it.shutdown()
        it.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS)
    }

    @Test
    fun `a warm is fetched normally`() {
        OkHttpWarmFetch(client).warm("https://cdn.example.com/a.m4s", 1024)
        awaitIdle()
        assertEquals(1, requests)
    }

    @Test
    fun `a warm is skipped while the system's Data Saver is on`() {
        OkHttpWarmFetch(client) { true }.warm("https://cdn.example.com/a.m4s", 1024)
        awaitIdle()
        assertEquals(0, requests)
    }
}
