package dev.opensesame.authenticator

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import uniffi.opensesame_authenticator_core.NativeCanaryMutation

@Composable
fun NativeCanaryView(activity: FragmentActivity, onBack: () -> Unit) {
    var status by remember { mutableStateOf<JSONObject?>(null) }
    var password by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var outgoing by remember { mutableStateOf<String?>(null) }
    var outputPermit by remember { mutableStateOf<NativeSession.Real?>(null) }
    var pairing by remember { mutableStateOf<String?>(null) }
    var pairingOrigin by remember { mutableStateOf<String?>(null) }
    var importPermit by remember { mutableStateOf<NativeSession.Real?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun refresh(permit: NativeSession.Real) {
        NativeGate.requireSame(permit)
        val next = NativeGate.canaryStatus(activity)
        NativeGate.requireSame(permit)
        status = next
    }
    LaunchedEffect(Unit) {
        runCatching { val permit = NativeGate.requireReal(); refresh(permit) }
            .onFailure { message = "Canary settings unavailable. Set an application password first." }
    }
    fun work(action: suspend (String, NativeSession.Real) -> Unit) {
        val permit = runCatching { NativeGate.requireReal() }.getOrElse { message = "Authenticate the real owner again."; return }
        val current = password
        password = ""; busy = true; message = null
        scope.launch {
            runCatching { NativeGate.requireSame(permit); action(current, permit); refresh(permit) }
                .onFailure { message = "Owner verification or canary operation failed." }
            busy = false
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        val text = outgoing
        val permit = outputPermit
        outgoing = null; outputPermit = null
        if (uri != null && text != null && permit != null) scope.launch {
            runCatching {
                NativeGate.requireSame(permit)
                withContext(Dispatchers.IO) {
                    NativeGate.requireSame(permit)
                    activity.contentResolver.openOutputStream(uri, "wt").use { output ->
                        checkNotNull(output)
                        NativeGate.requireSame(permit)
                        output.write(text.toByteArray(Charsets.UTF_8))
                        NativeGate.requireSame(permit)
                    }
                }
                NativeGate.requireSame(permit)
                message = "Export saved once. Keep it private; detector evidence stays in the CLI environment."
            }.onFailure { message = "Export cancelled or owner session changed." }
        }
    }
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        val permit = importPermit
        importPermit = null; pairing = null; pairingOrigin = null
        if (uri != null && permit != null) scope.launch {
            runCatching {
                NativeGate.requireSame(permit)
                val text = withContext(Dispatchers.IO) {
                    activity.contentResolver.openInputStream(uri).use { input ->
                        checkNotNull(input)
                        val bytes = ByteArray(8193)
                        var size = 0
                        while (size < bytes.size) {
                            val count = input.read(bytes, size, bytes.size - size)
                            if (count < 0) break
                            size += count
                        }
                        check(size <= 8192)
                        bytes.copyOf(size).toString(Charsets.UTF_8)
                    }
                }
                NativeGate.requireSame(permit)
                val objectValue = JSONObject(text)
                pairingOrigin = objectValue.getString("origin")
                pairing = text
            }.onFailure { message = "Pairing file invalid or owner session changed." }
        }
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Security · Decoy · Controlled canaries")
        Text("Synthetic validators only. No real wallet keys, production credentials or connectors. Local-only by default; reading bait is not observable. Connection references are detection-only and never valid vendor credentials.")
        OutlinedTextField(password, { password = it }, label = { Text("Current application password for canaries") },
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), singleLine = true, enabled = !busy)
        for ((kind, label) in listOf("mcp_configuration" to "MCP configuration", "connection_ref" to "Connection reference")) {
            Button(enabled = !busy && password.isNotEmpty() && status != null && status!!.getJSONArray("artifacts").length() < 16, onClick = {
                work { current, permit ->
                    val artifact = JSONObject(NativeGate.manageCanary(activity, current, NativeCanaryMutation.Create(kind), permit))
                    NativeGate.requireSame(permit)
                    val export = if (kind == "mcp_configuration") {
                        val binding = JSONObject(NativeGate.manageCanary(activity, current,
                            NativeCanaryMutation.ExportValidator(artifact.getString("id"), artifact.getString("presentedId")), permit))
                        JSONObject().put("v", 1).put("tomb", "native-wallet-credential-observations.v1").put("artifact", artifact)
                            .put("validatorBinding", binding).put("mcpServers", JSONObject().put("OpenSesameCanary", JSONObject()
                                .put("command", "opensesame-id").put("args", JSONArray(listOf("canary", "serve", "--config", "opensesame-canary.json")))))
                    } else JSONObject().put("v", 1).put("artifact", artifact).put("reference", "oscanary:v1:" + artifact.getString("presentedId"))
                    val text = export.toString(2)
                    check(text.toByteArray(Charsets.UTF_8).size <= 4096)
                    NativeGate.requireSame(permit)
                    outgoing = text; outputPermit = permit
                    message = "Export prepared once. Choose a private file destination."
                }
            }) { Text("Create $label canary") }
        }
        if (outgoing != null) Button(enabled = !busy, onClick = { save.launch("opensesame-canary.json") }) { Text("Save one-time canary export") }
        Text("Prepare an owner-only file (chmod 600 FILE on Unix). Install MCP export with opensesame-id canary install --config FILE --trust-configuration. Revoke the offline detector separately with opensesame-id canary uninstall --config FILE.")
        val artifacts = status?.optJSONArray("artifacts") ?: JSONArray()
        for (index in 0 until artifacts.length()) {
            val artifact = artifacts.getJSONObject(index)
            Text("Canary ${index + 1} · ${artifact.getJSONObject("context").getString("kind")} · generation ${artifact.getJSONObject("context").getInt("generation")}")
            Button(enabled = !busy && password.isNotEmpty() && status != null, onClick = { work { current, permit ->
                NativeGate.manageCanary(activity, current, NativeCanaryMutation.Remove(artifact.getString("id")), permit)
            } }) { Text("Revoke canary ${index + 1}") }
        }
        Text("Local canary observations: ${status?.optJSONArray("events")?.length() ?: 0}")
        Button(enabled = !busy && password.isNotEmpty() && status != null, onClick = { work { current, permit ->
            NativeGate.manageCanary(activity, current, NativeCanaryMutation.ClearEvents, permit)
        } }) { Text("Clear canary observations") }
        NativeIssuerRows(activity, !busy && password.isNotEmpty() && status != null) { action -> work(action) }
        Text("Optional observation receiver")
        Text("Import independent pairing supplied by your receiver. No service is provisioned automatically. Configuration begins disabled until authenticated sealed delivery succeeds. Android network policy requires HTTPS; loopback HTTP may be refused.")
        Button(enabled = !busy, onClick = {
            runCatching { importPermit = NativeGate.requireReal(); import.launch(arrayOf("application/json")) }
                .onFailure { message = "Authenticate the real owner again." }
        }) { Text("Import receiver pairing file") }
        pairingOrigin?.let { Text("Confirm receiver destination: $it") }
        Button(enabled = !busy && password.isNotEmpty() && pairing != null, onClick = {
            val raw = pairing ?: return@Button
            work { current, permit -> NativeGate.manageCanary(activity, current, NativeCanaryMutation.ConfigureReceiver(raw), permit); pairing = null; pairingOrigin = null }
        }) { Text("Confirm receiver destination") }
        val receiver = status?.optJSONObject("receiver")
        receiver?.let { Text("Receiver ${it.getString("origin")} · ${if (it.getBoolean("enabled")) "enabled" else "disabled"} · ${if (it.getBoolean("verified")) "verified" else "unverified"}") }
        Button(enabled = !busy && password.isNotEmpty() && receiver != null, onClick = { work { current, permit ->
            message = if (NativeGate.testCanaryReceiver(activity, current, permit)) "Receiver acknowledged sealed delivery." else "No authenticated delivery acknowledgement."
        } }) { Text("Test sealed receiver delivery") }
        Button(enabled = !busy && password.isNotEmpty() && receiver != null && (receiver.optBoolean("enabled") || receiver.optBoolean("verified")), onClick = { work { current, permit ->
            NativeGate.manageCanary(activity, current, NativeCanaryMutation.EnableReceiver(!checkNotNull(receiver).getBoolean("enabled")), permit)
        } }) { Text(if (receiver?.optBoolean("enabled") == true) "Disable observation receiver" else "Enable observation receiver") }
        Button(enabled = !busy && password.isNotEmpty() && receiver != null, onClick = { work { current, permit ->
            NativeGate.manageCanary(activity, current, NativeCanaryMutation.RemoveReceiver, permit)
        } }) { Text("Remove observation receiver") }
        Text("Queued sealed metadata: ${status?.optInt("queued") ?: 0}; failed attempts: ${status?.optInt("failed") ?: 0}. Removal preserves local observations.")
        message?.let { Text(it) }
        Button(onClick = { outgoing = null; pairing = null; onBack() }) { Text("Back to retired passwords") }
    }
}
