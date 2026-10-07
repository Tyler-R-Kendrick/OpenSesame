package dev.opensesame.authenticator

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.HttpClientEngineBase
import kotlinx.coroutines.cancel
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.client.engine.android.Android
import io.ktor.client.engine.android.AndroidEngineConfig
import io.ktor.utils.io.InternalAPI

/** Covers both issuance HTTP and remote-attestation RPC, including in-flight response handback. */
@OptIn(InternalAPI::class)
class RealmHttpEngine(private val permit: NativeSession.Real) : HttpClientEngineFactory<AndroidEngineConfig> {
    override fun create(block: AndroidEngineConfig.() -> Unit): HttpClientEngine {
        NativeGate.requireSame(permit)
        val delegate = Android.create(block)
        return guardedRealmHttpEngine(delegate, { NativeGate.requireSame(permit) }) {
            NativeGate.onInvalidated(permit, it)
        }
    }
}

/** Owns install's receiver and job: interface delegation would install the unguarded delegate. */
@OptIn(InternalAPI::class)
internal fun guardedRealmHttpEngine(
    delegate: HttpClientEngine,
    requireCurrent: () -> Unit,
    subscribe: (() -> Unit) -> (() -> Unit),
): HttpClientEngine = object : HttpClientEngineBase("realm-guard") {
    override val config get() = delegate.config
    override val dispatcher get() = delegate.dispatcher
    override val supportedCapabilities get() = delegate.supportedCapabilities
    private val closed = AtomicBoolean()
    private val unsubscribe = AtomicReference<(() -> Unit)?>(null)
    init {
        try {
            val remove = subscribe { close() }
            unsubscribe.set(remove)
            if (closed.get()) unsubscribe.getAndSet(null)?.invoke()
        } catch (failure: Throwable) { close(); throw failure }
    }
    override suspend fun execute(data: HttpRequestData): HttpResponseData {
        requireCurrent()
        val response = delegate.execute(data)
        requireCurrent()
        return response
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        unsubscribe.getAndSet(null)?.invoke()
        coroutineContext.cancel()
        try { delegate.close() } finally { super.close() }
    }
}
