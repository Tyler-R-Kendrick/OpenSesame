package dev.opensesame.authenticator

import org.junit.Assert.assertThrows
import org.junit.Test

class NativeCanaryIssuerInventoryTest {
    private val identity = "e0e1c9b1-569a-4574-af58-c6893e535cc1"
    private val row = NativeRetiredIssuerIdentifier(
        "b94ab8bd-b014-4814-9d9b-9c7bc706d324", identity, "agent_lease", 1,
    )

    @Test fun authenticInventoryMetadataKeepsSupportedGenerationKinds() {
        validateNativeIssuerInventory(identity, listOf(row))
        validateNativeIssuerInventory(identity, listOf(row.copy(kind = "token_generation", generation = 0xffffffffL)))
    }

    @Test fun rejectsWrongVaultAndCallerInventedKinds() {
        assertThrows(IllegalStateException::class.java) {
            validateNativeIssuerInventory(identity, listOf(row.copy(vaultIdentity = "other-vault")))
        }
        assertThrows(IllegalStateException::class.java) {
            validateNativeIssuerInventory(identity, listOf(row.copy(kind = "vendor_password")))
        }
    }

    @Test fun rejectsDuplicateReferencesUnboundedInventoryAndInvalidGenerations() {
        for (rows in listOf(listOf(row, row), List(17) { row },
            listOf(row.copy(generation = 0)), listOf(row.copy(generation = 0x100000000L)))) {
            assertThrows(IllegalStateException::class.java) { validateNativeIssuerInventory(identity, rows) }
        }
    }

    @Test fun rejectsNoncanonicalPublicReferences() {
        assertThrows(IllegalStateException::class.java) {
            validateNativeIssuerInventory(identity, listOf(row.copy(issuerRecordRef = row.issuerRecordRef.uppercase())))
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateNativeIssuerInventory(identity, listOf(row.copy(issuerRecordRef = "not-an-issuer-reference")))
        }
    }
}
