package dev.opensesame.authenticator

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.net.CookieHandler
import java.net.CookieManager
import java.net.CookiePolicy
import java.net.HttpCookie
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Real loopback HTTP transport; no mocked network or successful receiver ACK claim. */
class NativeCanaryTransportTest {
    private class Server(private val response: String) : AutoCloseable {
        val socket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val request = CompletableFuture<String>()
        val destination = "http://127.0.0.1:${socket.localPort}/v1/credential-observations"
        private val worker = thread(name = "canary-receiver-fixture") {
            runCatching {
                socket.accept().use { connection ->
                    connection.soTimeout = 5000
                    val reader = connection.getInputStream().bufferedReader(Charsets.UTF_8)
                    val headers = mutableListOf<String>()
                    while (true) {
                        val line = reader.readLine() ?: error("Missing HTTP headers")
                        if (line.isEmpty()) break
                        headers.add(line)
                    }
                    val length = headers.firstOrNull { it.startsWith("Content-Length:", true) }?.substringAfter(":")?.trim()?.toInt() ?: 0
                    check(length in 0..8192)
                    var remaining = length
                    val payload = CharArray(length)
                    while (remaining > 0) {
                        val count = reader.read(payload, length - remaining, remaining)
                        check(count > 0)
                        remaining -= count
                    }
                    request.complete(headers.joinToString("\n"))
                    connection.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
                    connection.getOutputStream().flush()
                }
            }.onFailure { request.completeExceptionally(it) }
        }
        override fun close() { socket.close(); worker.join(6000) }
    }
    @Test fun dedicatedReceiverNeverSendsAmbientCookiesOrAuthentication() {
        val previous = CookieHandler.getDefault()
        Server("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"controlled-fixture\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").use { server ->
            val manager = CookieManager(null, CookiePolicy.ACCEPT_ALL)
            manager.cookieStore.add(URI(server.destination), HttpCookie("fixture_cookie", "ambient_cookie_fixture").apply { path = "/" })
            CookieHandler.setDefault(manager)
            try {
                val pending = NativeCanaryTransport.begin(server.destination, "{\"fixture\":\"sealed-metadata-transport-only\"}")
                assertNull(runBlocking { pending.acknowledgement.await() })
                val request = server.request.get(5, TimeUnit.SECONDS)
                assertTrue(request.startsWith("POST /v1/credential-observations HTTP/1.1"))
                assertFalse(request.lowercase().contains("cookie:"))
                assertFalse(request.lowercase().contains("authorization:"))
            } finally { CookieHandler.setDefault(previous) }
        }
    }
    @Test fun receiverDoesNotFollowRedirectAndRejectsOversizedAcknowledgement() {
        Server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").use { target ->
            Server("HTTP/1.1 302 Found\r\nLocation: ${target.destination}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").use { server ->
                assertNull(runBlocking { NativeCanaryTransport.begin(server.destination, "{}").acknowledgement.await() })
                assertTrue(server.request.get(5, TimeUnit.SECONDS).contains("/v1/credential-observations"))
                assertFalse("A redirect must never reach another real receiver", target.request.isDone)
            }
        }
        val oversized = "x".repeat(2049)
        Server("HTTP/1.1 200 OK\r\nContent-Length: ${oversized.length}\r\nConnection: close\r\n\r\n$oversized").use { server ->
            assertNull(runBlocking { NativeCanaryTransport.begin(server.destination, "{}").acknowledgement.await() })
        }
    }
    @Test fun transportRefusesGenericDestinationsAndOversizedOutboundDataBeforeNetwork() {
        assertThrows(IllegalStateException::class.java) { NativeCanaryTransport.begin("https://receiver.example.invalid/not-the-fixed-route", "{}") }
        assertThrows(IllegalStateException::class.java) { NativeCanaryTransport.begin("http://receiver.example.invalid/v1/credential-observations", "{}") }
        assertThrows(IllegalStateException::class.java) { NativeCanaryTransport.begin("https://receiver.example.invalid/v1/credential-observations?token=fixture", "{}") }
        assertThrows(IllegalStateException::class.java) { NativeCanaryTransport.begin("https://receiver.example.invalid/v1/credential-observations", "x".repeat(8193)) }
    }
}
