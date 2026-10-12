package dev.opensesame.authenticator

import android.os.Bundle
import io.ktor.client.engine.android.Android
import org.multipaz.compose.presentment.UriSchemePresentmentActivity
import uniffi.opensesame_authenticator_core.validatePresentationSchemeHandoff

class OpenId4VpActivity : UriSchemePresentmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val raw = intent?.data?.toString()
        if (raw != null) {
            runCatching {
                validatePresentationSchemeHandoff(
                    "https://${BuildConfig.INVOCATION_HOST}",
                    raw,
                )
            }.onFailure {
                finish()
                return
            }
        }
        super.onCreate(savedInstanceState)
    }

    override suspend fun getSettings(): Settings {
        WalletRuntime.initialize()
        return Settings(WalletRuntime.presentmentSource, Android)
    }
}
