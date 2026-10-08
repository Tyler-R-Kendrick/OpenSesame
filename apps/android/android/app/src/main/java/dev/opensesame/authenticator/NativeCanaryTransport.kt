package dev.opensesame.authenticator

import kotlinx.coroutines.CompletableDeferred
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

/** One fixed sealed-metadata route. No wallet engine, cookies, tokens or redirects. */
internal object NativeCanaryTransport {
    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE)
        .followRedirects(false).followSslRedirects(false)
        .callTimeout(4, TimeUnit.SECONDS)
        .connectTimeout(4, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS)
        .build()
    class Pending(val call: Call, val acknowledgement: CompletableDeferred<String?>) {
        fun cancel() { call.cancel(); acknowledgement.cancel() }
    }
    /** Enqueue must happen while binding revocation is excluded by NativeGate's mutex. */
    fun begin(destination: String, packet: String): Pending {
        val uri = URI(destination)
        check(uri.rawPath == "/v1/credential-observations" && uri.rawQuery == null &&
            uri.rawFragment == null && uri.rawUserInfo == null)
        check(uri.scheme == "https" || (uri.scheme == "http" &&
            uri.host in setOf("localhost", "127.0.0.1", "[::1]", "::1")))
        check(packet.toByteArray(Charsets.UTF_8).size <= 8192)
        val request = Request.Builder().url(destination)
            .post(packet.toRequestBody("application/json".toMediaType())).build()
        val call = client.newCall(request)
        val result = CompletableDeferred<String?>()
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { result.complete(null) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val ack = runCatching {
                        check(response.isSuccessful)
                        val body = checkNotNull(response.body)
                        body.byteStream().use { stream ->
                            val bytes = ByteArray(2049)
                            var size = 0
                            while (size < bytes.size) {
                                val read = stream.read(bytes, size, bytes.size - size)
                                if (read < 0) break
                                size += read
                            }
                            check(size <= 2048)
                            bytes.copyOf(size).toString(Charsets.UTF_8)
                        }
                    }.getOrNull()
                    result.complete(ack)
                }
            }
        })
        return Pending(call, result)
    }
}
