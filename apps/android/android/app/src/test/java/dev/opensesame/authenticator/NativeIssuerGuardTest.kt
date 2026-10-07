package dev.opensesame.authenticator

import org.junit.Assert.*
import org.junit.Test
import uniffi.opensesame_authenticator_core.*
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real Rust owner KDF and foreign callback; no Android OS authentication claim. */
class NativeIssuerGuardTest {
    private val now = "2026-10-06T00:00:00.000Z"
    private val ref = "53b1678d-a57b-411c-af33-d23d0dd25ec2"
    private fun artifact(identity: String): String {
        val digest = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
        return """{"id":"$ref","context":{"vaultIdentity":"$identity","kind":"connection_ref","generation":1},"digestB64":"$digest","state":"retired","createdAt":"$now","retiredAt":"$now"}"""
    }
    private fun provider(calls: AtomicInteger, action: () -> Unit = {}): NativeCanaryIssuerProvider =
        object : NativeCanaryIssuerProvider {
            override fun retireAuthenticated(issuerRecordRef: String, expectedVaultIdentity: String): String {
                assertEquals(ref, issuerRecordRef)
                calls.incrementAndGet()
                action()
                return artifact(expectedVaultIdentity)
            }
        }
    private fun stalePolicy(holdBeforeDelegate: Boolean) {
        val original = nativeGateCreate("owner")
        val stored = AtomicReference(original)
        val realm = NativeRealmState().apply { enterReal(lock()) }
        val permit = realm.requireReal()
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val calls = AtomicInteger()
        val read = {
            if (holdBeforeDelegate) { held.countDown(); check(release.await(60, TimeUnit.SECONDS)) }
            stored.get()
        }
        val delegate = provider(calls) {
            if (!holdBeforeDelegate) { held.countDown(); check(release.await(60, TimeUnit.SECONDS)) }
        }
        val guarded = guardNativeIssuerProvider(original, read, { realm.requireSame(permit) }, delegate)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val pending = executor.submit<NativeCanaryOwnerResult> {
                nativeCanaryRetireIssued(original, "owner", null, ref, guarded, now)
            }
            assertTrue(held.await(60, TimeUnit.SECONDS))
            stored.set(nativeGateChangePassword(stored.get(), "owner", "next owner"))
            realm.requireSame(permit) // Normal owner-policy changes do not change this real epoch.
            release.countDown()
            val failure = assertThrows(ExecutionException::class.java) { pending.get(60, TimeUnit.SECONDS) }
            assertTrue(failure.cause is NativeGateException)
            assertEquals(if (holdBeforeDelegate) 0 else 1, calls.get())
            assertEquals(NativeRealm.REAL, nativeGateAdmit(stored.get(), "next owner", now).realm)
            // Positive current-policy control: the identical independently trusted metadata is valid.
            val current = stored.get()
            val fresh = guardNativeIssuerProvider(current, { stored.get() }, { realm.requireSame(permit) }, provider(AtomicInteger()))
            val result = nativeCanaryRetireIssued(current, "next owner", null, ref, fresh, now)
            assertTrue(nativeCanaryStatus(result.gateRecord, result.stateRecord).contains(ref))
        } finally { release.countDown(); executor.shutdownNow() }
    }
    @Test fun passwordChangeAfterRealKdfBeforeForeignDispatchPreventsHostCall() = stalePolicy(true)
    @Test fun passwordChangeDuringForeignDispatchRefusesEnrollmentAfterReturn() = stalePolicy(false)
}
