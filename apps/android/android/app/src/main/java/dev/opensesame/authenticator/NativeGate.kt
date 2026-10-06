package dev.opensesame.authenticator

import android.content.Context
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import uniffi.opensesame_authenticator_core.*

/** Separate application admission, never an issuer code or a wallet storage encryption key. */
object NativeGate {
    private val realms = NativeRealmState()
    val session: NativeSession get() = realms.session
    private val mutex = Mutex()
    private var activeTrap: String? = null
    private var appContext: Context? = null
    private val evidenceScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
    @Volatile private var installedCanaryIssuer: NativeCanaryIssuerRuntime? = null
    private val pendingObservations = mutableSetOf<NativeCanaryTransport.Pending>()
    private val nowFormatter = java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun observationNow(): String = nowFormatter.format(Instant.now())

    fun requireReal(): NativeSession.Real {
        if (session is NativeSession.Synthetic) observeDenied()
        return realms.requireReal()
    }
    fun observeDenied() {
        val captured = session
        val id = activeTrap ?: return
        val context = appContext ?: return
        if (captured !is NativeSession.Synthetic) return
        evidenceScope.launch {
            runCatching { mutex.withLock {
                if (session == captured) read(context)?.let {
                    save(context, nativeGateAuthorityDenied(it, id, Instant.now().toString()))
                    queueLatestObservation(context)
                    flushObservations(context)
                }
            } }
        }
    }
    fun requireSame(permit: NativeSession.Real) { realms.requireSame(permit) }
    fun onInvalidated(permit: NativeSession.Real, callback: () -> Unit): () -> Unit =
        realms.onInvalidated(permit, callback)
    fun lock() { activeTrap = null; realms.lock(); WalletRuntime.lock() }

    private fun read(context: Context): String? = NativeCanaryStorage.readGate(context)
    private fun save(context: Context, record: String) = NativeCanaryStorage.saveGate(context, record)
    private fun saveOwned(context: Context, permit: NativeSession.Real, record: String) {
        realms.withSame(permit) { save(context, record) }
    }
    suspend fun configured(context: Context): Boolean = withContext(Dispatchers.IO) { read(context) != null }
    suspend fun status(context: Context): JSONObject = withContext(Dispatchers.IO) {
        val permit = requireReal()
        val value = JSONObject(read(context)?.let { nativeGateStatus(it) } ?: "{\"traps\":[],\"events\":[]}")
        requireSame(permit)
        value
    }
    suspend fun admit(activity: FragmentActivity, password: String) = mutex.withLock {
        appContext = activity.applicationContext
        WalletRuntime.lock()
        activeTrap = null
        val epoch = realms.lock()
        val admission = withContext(Dispatchers.Default) {
            val record = read(activity) ?: return@withContext null
            nativeGateAdmit(record, password, Instant.now().toString()).also {
                save(activity, it.record)
                if (it.trapId != null) { queueLatestObservation(activity); flushObservations(activity) }
            }
        }
        when (admission?.realm) {
            NativeRealm.SYNTHETIC -> { realms.enterSynthetic(epoch); activeTrap = admission.trapId }
            NativeRealm.REJECTED -> error("Password was not accepted")
            NativeRealm.REAL, null -> {
                ownerProof(activity)
                realms.enterReal(epoch)
            }
        }
    }
    suspend fun setup(activity: FragmentActivity, password: String, permit: NativeSession.Real = requireReal()) = mutex.withLock {
        requireSame(permit)
        ownerProof(activity)
        requireSame(permit)
        withContext(Dispatchers.Default) {
            check(read(activity) == null) { "Application password is already configured" }
            val record = nativeGateCreate(password)
            saveOwned(activity, permit, record)
        }
    }
    suspend fun manage(activity: FragmentActivity, current: String, permit: NativeSession.Real = requireReal(), operation: (String) -> String) = mutex.withLock {
        requireSame(permit)
        ownerProof(activity)
        requireSame(permit)
        withContext(Dispatchers.Default) {
            val record = read(activity) ?: error("Set an application password first")
            check(nativeGateAdmit(record, current, Instant.now().toString()).realm == NativeRealm.REAL)
            requireSame(permit)
            val next = operation(record)
            saveOwned(activity, permit, next)
        }
    }
    private fun commitCanaryOwned(context: Context, permit: NativeSession.Real,
        original: NativeCanaryStorage.Snapshot, gate: String, state: String) {
        realms.withSame(permit) { NativeCanaryStorage.commit(context, original, gate, state) }
    }
    suspend fun canaryStatus(context: Context): JSONObject = mutex.withLock {
        val permit = requireReal()
        withContext(Dispatchers.IO) {
            val snapshot = NativeCanaryStorage.snapshot(context)
            requireSame(permit)
            val status = nativeCanaryStatus(snapshot.gate ?: error("Set an application password first"), snapshot.state)
            requireSame(permit)
            JSONObject(status)
        }
    }
    suspend fun manageCanary(activity: FragmentActivity, current: String, operation: NativeCanaryMutation, permit: NativeSession.Real = requireReal()): String = mutex.withLock {
        requireSame(permit)
        ownerProof(activity)
        requireSame(permit)
        withContext(Dispatchers.Default) {
            val original = NativeCanaryStorage.snapshot(activity)
            requireSame(permit)
            val result = nativeCanaryManage(original.gate ?: error("Set an application password first"), current,
                original.state, operation, observationNow())
            requireSame(permit)
            realms.withSame(permit) {
                // Reconfiguration, disabling and removal revoke all queued/in-flight dispatch descendants.
                if (operation is NativeCanaryMutation.ConfigureReceiver || operation is NativeCanaryMutation.EnableReceiver ||
                    operation is NativeCanaryMutation.RemoveReceiver) {
                    pendingObservations.forEach { it.cancel() }
                    pendingObservations.clear()
                }
                commitCanaryOwned(activity, permit, original, result.gateRecord, result.stateRecord)
            }
            requireSame(permit)
            result.output
        }
    }
    /** Trusted human runtime only. Native OS/password proof is never substituted for Host authentication. */
    internal fun installCanaryIssuer(runtime: NativeCanaryIssuerRuntime): () -> Unit {
        val permit = requireReal()
        realms.withSame(permit) { synchronized(this) { installedCanaryIssuer = runtime } }
        return { synchronized(this) { if (installedCanaryIssuer === runtime) installedCanaryIssuer = null } }
    }
    internal fun canaryIssuerAvailable(): Boolean = installedCanaryIssuer != null
    internal suspend fun issuedCanaryInventory(context: Context, permit: NativeSession.Real): NativeCanaryIssuerInventory {
        requireSame(permit)
        val runtime = installedCanaryIssuer ?: error("No independently authenticated Host issuer is installed")
        val identity = withContext(Dispatchers.IO) {
            val gate = read(context) ?: error("Set an application password first")
            requireSame(permit)
            JSONObject(gate).optString("vaultIdentity").also { check(it.isNotEmpty()) { "Fresh owner migration is required" } }
        }
        val rows = withContext(Dispatchers.IO) { runtime.inventory(identity) }
        requireSame(permit)
        check(installedCanaryIssuer === runtime)
        validateNativeIssuerInventory(identity, rows)
        return NativeCanaryIssuerInventory(runtime, permit, identity, rows)
    }
    internal suspend fun retireIssuedCanary(activity: FragmentActivity, current: String,
        inventory: NativeCanaryIssuerInventory, selected: NativeRetiredIssuerIdentifier, permit: NativeSession.Real) {
        check(inventory.entries.contains(selected))
        requireSame(inventory.owner)
        check(inventory.owner == permit)
        val original = mutex.withLock {
            requireSame(permit)
            check(installedCanaryIssuer === inventory.runtime)
            ownerProof(activity)
            requireSame(permit)
            val snapshot = withContext(Dispatchers.IO) { NativeCanaryStorage.snapshot(activity) }
            requireSame(permit)
            check(JSONObject(checkNotNull(snapshot.gate)).getString("vaultIdentity") == inventory.vaultIdentity)
            snapshot
        }
        // The provider must perform its independent authenticated Host transaction; no application password crosses it.
        val guardedProvider = guardNativeIssuerProvider(checkNotNull(original.gate), { read(activity) }, {
            try {
                requireSame(permit)
                check(installedCanaryIssuer === inventory.runtime)
            } catch (_: IllegalStateException) {
                throw NativeGateException.OwnerRequired()
            }
        }, inventory.runtime.provider)
        val result = withContext(Dispatchers.IO) {
            requireSame(permit)
            nativeCanaryRetireIssued(checkNotNull(original.gate), current, original.state,
                selected.issuerRecordRef, guardedProvider, observationNow())
        }
        mutex.withLock {
            requireSame(permit)
            check(installedCanaryIssuer === inventory.runtime)
            commitCanaryOwned(activity, permit, original, result.gateRecord, result.stateRecord)
        }
    }
    suspend fun testCanaryReceiver(activity: FragmentActivity, current: String, permit: NativeSession.Real = requireReal()): Boolean {
        requireSame(permit)
        val packageId = manageCanary(activity, current, NativeCanaryMutation.TestReceiver, permit)
        requireSame(permit)
        if (packageId.isEmpty()) return false
        return deliverCanaryObservation(activity, packageId, true, permit)
    }
    private fun queueLatestObservation(context: Context) {
        runCatching {
            val original = NativeCanaryStorage.snapshot(context)
            val gate = original.gate ?: return
            val next = nativeCanaryQueueLatestPassword(gate, original.state, observationNow()) ?: return
            NativeCanaryStorage.commit(context, original, gate, next)
        }
    }
    private fun flushObservations(context: Context) {
        evidenceScope.launch { runCatching { repeat(2) { deliverCanaryObservation(context, null, false, null) } } }
    }
    private suspend fun deliverCanaryObservation(context: Context, packageId: String?, testing: Boolean,
        permit: NativeSession.Real?): Boolean = withContext(Dispatchers.IO) {
        val reserved = mutex.withLock {
            if (permit != null) requireSame(permit)
            if (pendingObservations.size >= 4) return@withLock null
            val original = NativeCanaryStorage.snapshot(context)
            val gate = original.gate ?: return@withLock null
            val state = original.state ?: return@withLock null
            val reservation = nativeCanaryReserve(gate, state, packageId, testing, observationNow()) ?: return@withLock null
            if (permit != null) requireSame(permit)
            NativeCanaryStorage.commit(context, original, gate, reservation.stateRecord)
            val current = NativeCanaryStorage.snapshot(context)
            if (!nativeCanaryDispatchCurrent(gate, checkNotNull(current.state), reservation.reservation, observationNow())) return@withLock null
            val start = {
                val pending = NativeCanaryTransport.begin(reservation.destination, reservation.packet)
                pendingObservations.add(pending)
                reservation to pending
            }
            if (permit != null) realms.withSame(permit, start) else start()
        } ?: return@withContext false
        val (reservation, request) = reserved
        val acknowledgement = try {
            request.acknowledgement.await()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            request.cancel()
            throw cancelled
        } finally {
            withContext(kotlinx.coroutines.NonCancellable) { mutex.withLock { pendingObservations.remove(request) } }
        }
        mutex.withLock {
            if (permit != null) requireSame(permit)
            val current = NativeCanaryStorage.snapshot(context)
            val gate = current.gate ?: return@withLock false
            val state = current.state ?: return@withLock false
            if (!nativeCanaryDispatchCurrent(gate, state, reservation.reservation, observationNow())) return@withLock false
            val result = nativeCanaryFinish(gate, state, reservation.reservation, acknowledgement, observationNow())
            if (permit != null) realms.withSame(permit) { NativeCanaryStorage.commit(context, current, gate, result.stateRecord) }
            else NativeCanaryStorage.commit(context, current, gate, result.stateRecord)
            result.delivered
        }
    }
    suspend fun ownerProof(activity: FragmentActivity) = withContext(Dispatchers.Main.immediate) {
      if (Build.VERSION.SDK_INT < 30) {
        val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val intent = keyguard.createConfirmDeviceCredentialIntent("Verify OpenSesame owner", "Unlock the real wallet")
            ?: error("Device owner authentication is unavailable")
        suspendCancellableCoroutine<Unit> { continuation ->
            lateinit var launcher: ActivityResultLauncher<Intent>
            launcher = activity.activityResultRegistry.register("opensesame-owner-${java.util.UUID.randomUUID()}",
                ActivityResultContracts.StartActivityForResult()) { result ->
                launcher.unregister()
                if (continuation.isActive) {
                    if (result.resultCode == Activity.RESULT_OK) continuation.resume(Unit)
                    else continuation.resumeWithException(IllegalStateException("Owner verification cancelled"))
                }
            }
            continuation.invokeOnCancellation { launcher.unregister() }
            launcher.launch(intent)
        }
      } else {
      suspendCancellableCoroutine<Unit> { continuation ->
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (continuation.isActive) continuation.resume(Unit)
                }
                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    if (continuation.isActive) continuation.resumeWithException(IllegalStateException("Owner verification cancelled"))
                }
            })
        continuation.invokeOnCancellation { prompt.cancelAuthentication() }
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Verify OpenSesame owner")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build())
      }
      }
    }
}
