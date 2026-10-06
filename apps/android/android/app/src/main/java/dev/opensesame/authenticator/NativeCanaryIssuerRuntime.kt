package dev.opensesame.authenticator

import uniffi.opensesame_authenticator_core.NativeCanaryIssuerProvider
import java.util.UUID

/**
 * Only an independently authenticated Host implementation may be installed by the human runtime.
 * Its revocation RPC must fence the original owner lifecycle and protected-gate policy at actual
 * network dispatch, including queued requests. Native password/OS proof is not Host authentication.
 * No adapter is installed by default; native vault identity cannot be guessed from a Host identity.
 */
internal class NativeCanaryIssuerRuntime(
    val provider: NativeCanaryIssuerProvider,
    val inventory: suspend (expectedVaultIdentity: String) -> List<NativeRetiredIssuerIdentifier>,
)
internal data class NativeRetiredIssuerIdentifier(
    val issuerRecordRef: String,
    val vaultIdentity: String,
    val kind: String,
    val generation: Long,
)
internal data class NativeCanaryIssuerInventory(
    val runtime: NativeCanaryIssuerRuntime,
    val owner: NativeSession.Real,
    val vaultIdentity: String,
    val entries: List<NativeRetiredIssuerIdentifier>,
)
internal fun validateNativeIssuerInventory(identity: String, rows: List<NativeRetiredIssuerIdentifier>) {
    check(rows.size <= 16 && rows.map { it.issuerRecordRef }.toSet().size == rows.size)
    for (row in rows) {
        check(UUID.fromString(row.issuerRecordRef).toString() == row.issuerRecordRef)
        check(row.vaultIdentity == identity && row.kind in setOf("token_generation", "agent_lease") &&
            row.generation in 1..0xffffffffL)
    }
}
