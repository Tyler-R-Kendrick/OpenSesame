package dev.opensesame.authenticator

import org.multipaz.compose.digitalcredentials.CredentialManagerPresentmentActivity

class DigitalCredentialsActivity : CredentialManagerPresentmentActivity() {
    override suspend fun getSettings(): Settings {
        WalletRuntime.initialize()
        return Settings(
            source = WalletRuntime.presentmentSource,
            privilegedAllowList = assets.open("privileged-user-agents.json")
                .bufferedReader()
                .use { it.readText() },
        )
    }
}
