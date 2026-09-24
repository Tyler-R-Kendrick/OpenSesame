package dev.opensesame.authenticator

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.multipaz.compose.prompt.PromptDialogs
import org.multipaz.provisioning.AuthorizationChallenge
import org.multipaz.provisioning.AuthorizationResponse
import org.multipaz.provisioning.ProvisioningModel
import org.multipaz.util.Platform
import uniffi.opensesame_authenticator_core.InvocationKind
import uniffi.opensesame_authenticator_core.validatePlatformInvocation

class MainActivity : FragmentActivity() {
    private var browserChallenge: AuthorizationChallenge.OAuth? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            WalletRuntime.initialize()
            handleIntent(intent)
            setContent {
                MaterialTheme {
                    Surface(Modifier.fillMaxSize()) {
                        PromptDialogs(Platform.promptModel)
                        val state by WalletRuntime.provisioningModel.state.collectAsState()
                        ProvisioningState(state)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        lifecycleScope.launch { handleIntent(intent) }
    }

    private suspend fun handleIntent(intent: Intent) {
        val uri = intent.data ?: return
        val waiting = browserChallenge
        if (waiting != null && uri.getQueryParameter("state") == waiting.state) {
            browserChallenge = null
            WalletRuntime.provisioningModel.provideAuthorizationResponse(
                AuthorizationResponse.OAuth(waiting.id, uri.toString()),
            )
            return
        }
        if (uri.scheme == "https") {
            val invocation = runCatching {
                validatePlatformInvocation(
                    "https://${BuildConfig.INVOCATION_HOST}",
                    uri.toString(),
                )
            }.getOrNull() ?: return
            if (invocation.kind == InvocationKind.OID4VP) {
                startActivity(
                    Intent(this, OpenId4VpActivity::class.java)
                        .setAction(Intent.ACTION_VIEW)
                        .setData(Uri.parse(invocation.protocolUri)),
                )
                return
            }
            if (invocation.kind != InvocationKind.OID4VCI) return
            WalletRuntime.provisioningModel.launchOpenID4VCIProvisioning(
                invocation.protocolUri,
                WalletRuntime.clientPreferences,
                WalletRuntime.backend,
            )
            return
        }
        val offer = when (uri.scheme) {
            "openid-credential-offer", "haip-vci" -> uri.toString()
            else -> return
        }
        WalletRuntime.provisioningModel.launchOpenID4VCIProvisioning(
            offer,
            WalletRuntime.clientPreferences,
            WalletRuntime.backend,
        )
    }

    @androidx.compose.runtime.Composable
    private fun ProvisioningState(state: ProvisioningModel.State) {
        Column(Modifier.padding(24.dp)) {
            Text("OpenSesame wallet", style = MaterialTheme.typography.headlineSmall)
            when (state) {
                ProvisioningModel.Idle -> Text("Ready for a credential offer.")
                ProvisioningModel.Initial,
                ProvisioningModel.Connected,
                ProvisioningModel.ProcessingAuthorization,
                ProvisioningModel.Authorized,
                ProvisioningModel.RequestingCredentials -> Text("Issuing credential…")
                is ProvisioningModel.CredentialsIssued ->
                    Text("Credential saved after issuer proof verification.")
                is ProvisioningModel.Error -> Text("Issuance failed: ${state.err.message}")
                is ProvisioningModel.Authorizing -> Authorization(state.authorizationChallenges)
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun Authorization(challenges: List<AuthorizationChallenge>) {
        val oauth = challenges.filterIsInstance<AuthorizationChallenge.OAuth>().firstOrNull()
        val secret = challenges.filterIsInstance<AuthorizationChallenge.SecretText>().firstOrNull()
        if (oauth != null) {
            Button(onClick = {
                browserChallenge = oauth
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(oauth.url)))
            }) { Text("Continue with issuer") }
        }
        if (secret != null) {
            var value by remember(secret.id) { mutableStateOf("") }
            OutlinedTextField(value, { value = it }, label = { Text("Issuer code") })
            Button(
                enabled = value.isNotEmpty(),
                onClick = {
                    val response = AuthorizationResponse.SecretText(secret.id, value)
                    value = ""
                    lifecycleScope.launch {
                        WalletRuntime.provisioningModel.provideAuthorizationResponse(response)
                    }
                },
            ) { Text("Submit") }
        }
    }
}
