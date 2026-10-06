import Foundation
import OpenSesameAuthenticatorCore

/// Captured on the main actor only after fresh OS owner proof; every lock revokes it.
/// The lock guards this witness, never Host transport or vault/keychain state.
final class NativeIssuerWitness: @unchecked Sendable {
    private let mutex = NSLock()
    private var current = true
    func revoke() { mutex.lock(); current = false; mutex.unlock() }
    func requireCurrent() throws {
        mutex.lock(); let allowed = current; mutex.unlock()
        guard allowed else { throw NativeGateError.OwnerRequired }
    }
}

/// The installed adapter must independently authenticate/fence actual Host dispatch. These
/// additional checks reject owner revocation during the preceding Rust password derivation.
final class NativeIssuerGuard: NativeCanaryIssuerProvider, @unchecked Sendable {
    private let delegate: any NativeCanaryIssuerProvider
    private let witness: NativeIssuerWitness
    private let policyCheck: @Sendable () throws -> Void
    init(delegate: any NativeCanaryIssuerProvider, witness: NativeIssuerWitness,
        policyCheck: @escaping @Sendable () throws -> Void) {
        self.delegate = delegate; self.witness = witness; self.policyCheck = policyCheck
    }
    func retireAuthenticated(issuerRecordRef: String, expectedVaultIdentity: String) throws -> String {
        try witness.requireCurrent(); try policyCheck()
        let metadata = try delegate.retireAuthenticated(issuerRecordRef: issuerRecordRef,
            expectedVaultIdentity: expectedVaultIdentity)
        try witness.requireCurrent(); try policyCheck()
        return metadata
    }
}
