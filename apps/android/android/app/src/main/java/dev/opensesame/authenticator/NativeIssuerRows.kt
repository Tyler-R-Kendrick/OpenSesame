package dev.opensesame.authenticator

import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch

/** Displays only bounded public references from an installed independently authenticated issuer. */
@Composable
internal fun NativeIssuerRows(activity: FragmentActivity, enabled: Boolean,
    work: (suspend (String, NativeSession.Real) -> Unit) -> Unit) {
    var inventory by remember { mutableStateOf<NativeCanaryIssuerInventory?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    if (!NativeGate.canaryIssuerAvailable()) {
        Text("Issued-generation retirement unavailable: no independently authenticated Host issuer is installed.")
        return
    }
    Text("Review already-retired issuer records. Native owner verification does not authenticate the Host.")
    Button(enabled = enabled, onClick = {
        val permit = runCatching { NativeGate.requireReal() }.getOrElse { message = "Authenticate the native owner again."; return@Button }
        scope.launch {
            runCatching {
                val next = NativeGate.issuedCanaryInventory(activity, permit)
                NativeGate.requireSame(permit)
                inventory = next
                message = if (next.entries.isEmpty()) "No authenticated retired issuer records are available." else null
            }.onFailure { inventory = null; message = "Authenticated issuer inventory unavailable." }
        }
    }) { Text("Review retired issuer generations") }
    inventory?.let { current ->
        for ((index, record) in current.entries.withIndex()) {
            Text("Retired ${record.kind} ${index + 1} · generation ${record.generation}")
            Button(enabled = enabled, onClick = { work { password, permit ->
                NativeGate.retireIssuedCanary(activity, password, current, record, permit)
                message = "Authenticated retired generation enrolled for observation."
            } }) { Text("Monitor retired issuer generation ${index + 1}") }
        }
    }
    message?.let { Text(it) }
}
