package dev.opensesame.authenticator

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.HttpClientEngineFactory
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
        return object : HttpClientEngine by delegate {
            override suspend fun execute(data: HttpRequestData): HttpResponseData {
                NativeGate.requireSame(permit)
                val response = delegate.execute(data)
                NativeGate.requireSame(permit)
                return response
            }
        }
    }
}
