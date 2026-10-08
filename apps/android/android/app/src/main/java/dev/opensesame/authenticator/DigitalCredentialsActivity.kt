package dev.opensesame.authenticator

import org.multipaz.compose.digitalcredentials.CredentialManagerPresentmentActivity

class DigitalCredentialsActivity : CredentialManagerPresentmentActivity() {
    override suspend fun getSettings(): Settings {
        val permit = NativeGate.requireReal()
        NativeGate.ownerProof(this)
        NativeGate.requireSame(permit)
        WalletRuntime.initialize()
        NativeGate.requireSame(permit)
        return Settings(
            source = WalletRuntime.presentmentSource,
            privilegedAllowList = assets.open("privileged-user-agents.json")
                .bufferedReader()
                .use { it.readText() },
        )
    }
}
