package dev.opensesame.authenticator

import org.junit.Assert.*
import org.junit.Test
import uniffi.opensesame_authenticator_core.*

/** Executes the generated Kotlin binding against the real host Rust library, never an Android OS prompt. */
class NativeFfiBehaviorTest {
    @Test fun retiredCredentialsRemainSyntheticAcrossActualFfi() {
        val now = "2026-10-05T12:00:00.000Z"
        val created = nativeGateCreate("former application password")
        val rotated = nativeGateChangePassword(created, "former application password", "current application password")
        val enrolled = nativeGateEnroll(rotated, "current application password", "former application password", true, now)
        val decoy = nativeGateAdmit(enrolled, "former application password", now)
        assertEquals(NativeRealm.SYNTHETIC, decoy.realm)
        val id = checkNotNull(decoy.trapId)
        val interacted = nativeGateAuthorityDenied(decoy.record, id, now)
        val status = nativeGateStatus(interacted)
        assertTrue(status.contains("synthetic_decoy_interaction"))
        assertFalse(status.contains("salt"))
        assertFalse(status.contains("verifier"))
        assertFalse(status.contains("former application password"))
        assertThrows(NativeGateException::class.java) {
            nativeGateRemove(interacted, "former application password", id)
        }
        val real = nativeGateAdmit(interacted, "current application password", now)
        assertEquals(NativeRealm.REAL, real.realm)
        assertNull(real.trapId)
        val cleared = nativeGateClearEvents(interacted, "current application password")
        assertTrue(nativeGateStatus(cleared).contains("\"events\":[]"))
    }
}
