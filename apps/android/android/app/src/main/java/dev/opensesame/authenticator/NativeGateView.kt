package dev.opensesame.authenticator

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import uniffi.opensesame_authenticator_core.*

@Composable
fun NativeAdmissionView(activity: FragmentActivity, onAdmission: () -> Unit) {
    var password by remember { mutableStateOf("") }
    var configured by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { runCatching { NativeGate.configured(activity) }.onSuccess { configured = it }.onFailure { error = "Wallet gate unavailable" } }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Unlock OpenSesame")
        if (configured == true) SecretField(password, { password = it }, "Application password")
        Text("Real wallet access also requires device owner verification.")
        error?.let { Text(it) }
        Button(enabled = !busy && configured != null && (configured == false || password.isNotEmpty()), onClick = {
            busy = true
            val submitted = password
            password = ""
            scope.launch {
                runCatching { NativeGate.admit(activity, submitted) }.onSuccess { onAdmission() }
                    .onFailure { error = "Wallet could not be unlocked" }
                busy = false
            }
        }) { Text("Unlock") }
    }
}

@Composable
fun SyntheticWalletView(onLock: () -> Unit) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("OpenSesame wallet")
        Text("Example membership · member@example.invalid")
        Text("Example credential · issued by Example organization")
        Button(onClick = onLock) { Text("Lock") }
    }
}

@Composable
fun NativeSecurityView(activity: FragmentActivity, onDone: () -> Unit) {
    var canaries by remember { mutableStateOf(false) }
    if (canaries) { NativeCanaryView(activity) { canaries = false }; return }
    var status by remember { mutableStateOf(JSONObject("{\"traps\":[],\"events\":[]}")) }
    var configured by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf("") }
    var retired by remember { mutableStateOf("") }
    var nextPassword by remember { mutableStateOf("") }
    var synthetic by remember { mutableStateOf(false) }
    var consent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun refresh(permit: NativeSession.Real = NativeGate.requireReal()) {
        NativeGate.requireSame(permit)
        val nextConfigured = NativeGate.configured(activity)
        NativeGate.requireSame(permit)
        val nextStatus = NativeGate.status(activity)
        NativeGate.requireSame(permit)
        configured = nextConfigured; status = nextStatus
    }
    LaunchedEffect(Unit) { runCatching { refresh() }.onFailure { error = "Security settings unavailable" } }
    fun work(operation: suspend (String, String, NativeSession.Real) -> Unit) {
        val permit = runCatching { NativeGate.requireReal() }.getOrElse { error = "Authenticate the real owner again"; return }
        val password = current
        val selected = retired
        current = ""; retired = ""; busy = true
        scope.launch {
            runCatching { NativeGate.requireSame(permit); operation(password, selected, permit); NativeGate.requireSame(permit); refresh(permit); NativeGate.requireSame(permit) }.onFailure { error = "Owner verification or operation failed" }
            busy = false
        }
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Security · Decoy · Retired passwords")
        Text("This is a local application admission gate. Wallet document keys remain protected by the operating system; this password does not re-encrypt wallet storage.")
        SecretField(current, { current = it }, if (configured) "Current application password" else "New application password")
        if (!configured) {
            Text("Use a unique application password. A salted Argon2id verifier is stored under the device key and can become an offline guessing target if extracted.")
            Button(enabled = !busy && current.isNotEmpty(), onClick = { work { password, _, permit -> NativeGate.setup(activity, password, permit) } }) { Text("Set application password") }
        } else {
            SecretField(nextPassword, { nextPassword = it }, "New application password")
            Button(enabled = !busy && current.isNotEmpty() && nextPassword.isNotEmpty(), onClick = {
                val next = nextPassword; nextPassword = ""
                work { password, _, permit -> NativeGate.manage(activity, password, permit) { nativeGateChangePassword(it, password, next) } }
            }) { Text("Change application password") }
            Text("Selected traps: ${status.getJSONArray("traps").length()}/3")
            SecretField(retired, { retired = it }, "Selected retired password")
            Text("Synthetic decoy (off means record and reject)")
            Switch(checked = synthetic, enabled = !busy, onCheckedChange = { synthetic = it })
            Text("Retaining a password verifier allows offline guesses and may expose reused passwords. Stale autofill can trigger local evidence; observations do not confirm an attacker. Local evidence by default; an optional configured receiver can receive sealed observations. No automatic freeze or wipe.")
            Checkbox(checked = consent, enabled = !busy, onCheckedChange = { consent = it })
            Text("I accept the verifier-retention risk.")
            Button(enabled = !busy && consent && current.isNotEmpty() && retired.isNotEmpty() && status.getJSONArray("traps").length() < 3,
                onClick = {
                    val response = synthetic
                    work { password, selected, permit -> NativeGate.manage(activity, password, permit) { nativeGateEnroll(it, password, selected, response, Instant.now().toString()) } }
                }) { Text("Enroll selected retired password") }
            val traps = status.getJSONArray("traps")
            for (index in 0 until traps.length()) {
                val trap = traps.getJSONObject(index)
                Text("Trap ${index + 1}: ${if (trap.getString("response") == "synthetic_decoy") "Synthetic decoy" else "Record and reject"}")
                Button(enabled = !busy && current.isNotEmpty(), onClick = { work { password, _, permit -> NativeGate.manage(activity, password, permit) { nativeGateRemove(it, password, trap.getString("id")) } } }) { Text("Remove trap ${index + 1}") }
            }
            Text("Local observations: ${status.getJSONArray("events").length()}/32")
            val events = status.getJSONArray("events")
            for (index in 0 until events.length()) {
                val event = events.getJSONObject(index)
                Text("${if (event.getString("type") == "synthetic_decoy_interaction") "External authority denied" else "Retired credential observed"} · ${event.getString("at")}")
            }
            Button(enabled = !busy && current.isNotEmpty(), onClick = { work { password, _, permit -> NativeGate.manage(activity, password, permit) { nativeGateClearEvents(it, password) } } }) { Text("Clear local evidence") }
        }
        if (configured) Button(enabled = !busy, onClick = { canaries = true }) { Text("Controlled canaries and observation receiver") }
        error?.let { Text(it) }
        Button(onClick = onDone) { Text("Back") }
    }
}

@Composable
private fun SecretField(value: String, onChange: (String) -> Unit, label: String) {
    OutlinedTextField(value, onChange, label = { Text(label) }, visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), singleLine = true)
}
