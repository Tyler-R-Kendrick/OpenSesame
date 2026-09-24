package dev.opensesame.authenticator

import io.ktor.client.engine.android.Android
import org.multipaz.compose.presentment.UriSchemePresentmentActivity

class OpenId4VpActivity : UriSchemePresentmentActivity() {
    override suspend fun getSettings(): Settings {
        WalletRuntime.initialize()
        return Settings(WalletRuntime.presentmentSource, Android)
    }
}
