package dev.opensesame.authenticator

import org.junit.Assert.*
import org.junit.Test

class NativeRealmStateTest {
    private fun rejects(operation: () -> Unit) {
        try { operation(); fail("Production authority was admitted") } catch (_: IllegalStateException) {}
    }
    @Test fun coldStartAndSyntheticNeverAdmitProduction() {
        val realm = NativeRealmState()
        var productions = 0
        fun initialize() { realm.requireReal(); productions++ }
        rejects { initialize() }
        realm.enterSynthetic(realm.lock())
        rejects { initialize() }
        assertEquals(0, productions)
    }
    @Test fun syntheticCannotUpgradeInPlace() {
        val realm = NativeRealmState()
        val generation = realm.lock()
        realm.enterSynthetic(generation)
        rejects { realm.enterReal(generation) }
        realm.enterReal(realm.lock())
        assertNotNull(realm.requireReal())
    }
    @Test fun lockAndNewRealAuthenticationInvalidateOldRequests() {
        val realm = NativeRealmState()
        realm.enterReal(realm.lock())
        val old = realm.requireReal()
        var externalActions = 0
        assertTrue(invokeNativeExternalAction(old, realm::requireSame) { externalActions++ })
        realm.lock()
        assertFalse(invokeNativeExternalAction(old, realm::requireSame) { externalActions++ })
        rejects { realm.requireSame(old) }
        realm.enterSynthetic(realm.lock())
        assertFalse(invokeNativeExternalAction(old, realm::requireSame) { externalActions++ })
        realm.enterReal(realm.lock())
        assertFalse(invokeNativeExternalAction(old, realm::requireSame) { externalActions++ })
        assertTrue(invokeNativeExternalAction(realm.requireReal(), realm::requireSame) { externalActions++ })
        assertEquals(2, externalActions)
        rejects { realm.requireSame(old) }
        realm.requireSame(realm.requireReal())
    }
    @Test fun cancelledOwnerPromptCannotReopenALockedWallet() {
        val realm = NativeRealmState()
        val promptGeneration = realm.lock()
        realm.lock()
        rejects { realm.enterReal(promptGeneration) }
        rejects { realm.enterSynthetic(promptGeneration) }
    }
    @Test fun staleOwnerDerivationCannotCommitAfterLock() {
        val realm = NativeRealmState()
        realm.enterReal(realm.lock())
        val owner = realm.requireReal()
        var saved = "original encrypted record"
        realm.withSame(owner) { saved = "authenticated owner update" }
        realm.lock()
        rejects { realm.withSame(owner) { saved = "stale owner derivation" } }
        assertEquals("authenticated owner update", saved)
        realm.enterSynthetic(realm.lock())
        rejects { realm.withSame(owner) { saved = "synthetic overwrite" } }
        assertEquals("authenticated owner update", saved)
    }
}
