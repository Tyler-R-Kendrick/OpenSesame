package dev.opensesame.authenticator

import uniffi.opensesame_authenticator_core.NativeCanaryIssuerProvider
import uniffi.opensesame_authenticator_core.NativeGateException

/** Fresh owner policy applies at the foreign dispatch boundary, after the Rust owner KDF. */
internal fun guardNativeIssuerProvider(originalGate: String, readGate: () -> String?,
    assertOwner: () -> Unit, provider: NativeCanaryIssuerProvider): NativeCanaryIssuerProvider {
    fun current() {
        assertOwner()
        if (readGate() != originalGate) throw NativeGateException.OwnerRequired()
        assertOwner()
    }
    return object : NativeCanaryIssuerProvider {
        override fun retireAuthenticated(issuerRecordRef: String, expectedVaultIdentity: String): String {
            current()
            val record = provider.retireAuthenticated(issuerRecordRef, expectedVaultIdentity)
            current()
            return record
        }
    }
}
