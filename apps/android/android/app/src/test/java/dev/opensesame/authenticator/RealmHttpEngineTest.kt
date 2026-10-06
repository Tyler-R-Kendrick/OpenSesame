package dev.opensesame.authenticator

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngineBase
import io.ktor.client.engine.HttpClientEngineConfig
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.get
import io.ktor.http.Headers
import io.ktor.http.HttpProtocolVersion
import io.ktor.http.HttpStatusCode
import io.ktor.util.date.GMTDate
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.InternalAPI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.yield
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import io.ktor.client.engine.callContext
import kotlinx.coroutines.withTimeout

/** Actual Ktor send pipeline and production realm state, without an Android OS admission claim. */
@OptIn(InternalAPI::class)
class RealmHttpEngineTest {
    private class Delegate : HttpClientEngineBase("realm-test") {
        override val config = HttpClientEngineConfig()
        val calls = AtomicInteger()
        val closes = AtomicInteger()
        val cancellations = AtomicInteger()
        var hold: CompletableDeferred<Unit>? = null
        val entered = CompletableDeferred<Unit>()
        override suspend fun execute(data: HttpRequestData): HttpResponseData {
            calls.incrementAndGet()
            entered.complete(Unit)
            try { hold?.await() } catch (cancelled: CancellationException) {
                cancellations.incrementAndGet()
                throw cancelled
            }
            return HttpResponseData(HttpStatusCode.OK, GMTDate(), Headers.Empty,
                HttpProtocolVersion.HTTP_1_1, ByteReadChannel("synthetic response"), callContext())
        }
        override fun close() { closes.incrementAndGet(); super.close() }
    }
    private fun client(delegate: Delegate, realm: NativeRealmState, permit: NativeSession.Real) =
        HttpClient(object : HttpClientEngineFactory<HttpClientEngineConfig> {
            override fun create(block: HttpClientEngineConfig.() -> Unit): HttpClientEngine {
                delegate.config.apply(block)
                return guardedRealmHttpEngine(delegate, { realm.requireSame(permit) }) {
                    realm.onInvalidated(permit, it)
                }
            }
        })
    private fun realm() = NativeRealmState().apply { enterReal(lock()) }
    @Test fun currentRealPipelineDispatchesAndClientCloseClosesDelegate() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal(); val delegate = Delegate()
        val client = client(delegate, realm, permit)
        assertEquals(HttpStatusCode.OK, client.get("https://fixture.example.test/").status)
        assertEquals(1, delegate.calls.get())
        client.close()
        while (delegate.closes.get() == 0) yield()
        assertEquals(1, delegate.closes.get())
    } }
    @Test fun lockedOrSyntheticPipelineNeverDispatches() = runBlocking { withTimeout(10000) {
        for (synthetic in listOf(false, true)) {
            val realm = realm(); val permit = realm.requireReal(); val delegate = Delegate()
            val client = client(delegate, realm, permit)
            val epoch = realm.lock(); if (synthetic) realm.enterSynthetic(epoch)
            try {
                assertTrue(runCatching { client.get("https://fixture.example.test/") }.isFailure)
                assertEquals(0, delegate.calls.get())
            } finally { client.close() }
        }
    } }
    @Test fun reauthenticationCannotReceivePendingOldResponse() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal(); val delegate = Delegate()
        val release = CompletableDeferred<Unit>(); delegate.hold = release
        val client = client(delegate, realm, permit)
        try {
            val pending = async { runCatching { client.get("https://fixture.example.test/") } }
            delegate.entered.await()
            realm.enterReal(realm.lock())
            release.complete(Unit)
            assertTrue(pending.await().isFailure)
            assertEquals(1, delegate.calls.get())
            assertTrue(runCatching { client.get("https://fixture.example.test/") }.isFailure)
            assertEquals(1, delegate.calls.get())
        } finally { release.complete(Unit); client.close() }
    } }

    @Test fun lockCancelsPendingCallWithoutNetworkRelease() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal(); val delegate = Delegate()
        val release = CompletableDeferred<Unit>(); delegate.hold = release
        val client = client(delegate, realm, permit)
        val pending = async { runCatching { client.get("https://fixture.example.test/") } }
        try {
            delegate.entered.await()
            realm.lock()
            assertTrue(pending.await().isFailure)
            assertFalse(release.isCompleted)
            assertEquals(1, delegate.cancellations.get())
            assertEquals(1, delegate.closes.get())
        } finally { release.complete(Unit); pending.cancelAndJoin(); client.close() }
    } }
    @Test fun cancellingCallerStopsDelegateAndCloseIsIdempotent() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal(); val delegate = Delegate()
        val release = CompletableDeferred<Unit>(); delegate.hold = release
        val client = client(delegate, realm, permit)
        val pending = async { client.get("https://fixture.example.test/") }
        try {
            delegate.entered.await()
            pending.cancelAndJoin()
            assertFalse(release.isCompleted)
            assertEquals(1, delegate.cancellations.get())
            client.close(); client.close(); realm.lock()
            assertEquals(1, delegate.closes.get())
        } finally { release.complete(Unit); pending.cancelAndJoin(); client.close() }
    } }
    @Test fun throwingRevocationCallbackCannotKeepOtherPermitsAlive() {
        val realm = realm(); val permit = realm.requireReal(); var cancelled = 0
        realm.onInvalidated(permit) { error("Fixture callback failure") }
        val removeOld = realm.onInvalidated(permit) { cancelled++ }
        realm.enterReal(realm.lock())
        assertEquals(1, cancelled)
        assertTrue(runCatching { realm.onInvalidated(permit) {} }.isFailure)
        realm.onInvalidated(realm.requireReal()) { cancelled++ }
        removeOld()
        realm.lock()
        assertEquals(2, cancelled)
    }
}
