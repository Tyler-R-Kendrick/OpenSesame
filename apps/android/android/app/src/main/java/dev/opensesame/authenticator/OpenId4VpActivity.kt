package dev.opensesame.authenticator

import org.multipaz.compose.presentment.UriSchemePresentmentActivity

class OpenId4VpActivity : UriSchemePresentmentActivity() {
    override suspend fun getSettings(): Settings {
        val permit = NativeGate.requireReal()
        NativeGate.ownerProof(this)
        NativeGate.requireSame(permit)
        WalletRuntime.initialize()
        NativeGate.requireSame(permit)
        return Settings(WalletRuntime.presentmentSource, RealmHttpEngine(permit))
    }
}
