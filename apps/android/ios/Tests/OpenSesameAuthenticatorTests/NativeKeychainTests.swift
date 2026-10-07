import Foundation
import OpenSesameAuthenticatorCore
import Security
import Testing
@testable import OpenSesameAuthenticator

@Suite(.serialized)
struct NativeKeychainTests {
    private let service = "dev.opensesame.native-admission.v1"
    private func cleanup() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service] as CFDictionary)
    }

    @Test func actualKeychainRecordUsesDeviceOnlyProtectionAndCasRejectsStaleMutation() throws {
        cleanup()
        defer { cleanup() }
        let record = try nativeGateCreate(password: "Apple SDK known test password")
        try NativeGateStorage.replaceRecord(expected: nil, next: record)
        #expect(try NativeGateStorage.read("record") == record)
        var attributes: CFTypeRef?
        let result = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "record",
            kSecReturnAttributes as String: true] as CFDictionary, &attributes)
        #expect(result == errSecSuccess)
        let protection = (attributes as? [String: Any])?[kSecAttrAccessible as String] as? String
        #expect(protection == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        #expect(throws: NativeStorageError.self) {
            try NativeGateStorage.replaceRecord(expected: "stale record", next: record)
        }
        #expect(try NativeGateStorage.read("record") == record)
    }

    @MainActor
    @Test func actualRustAndKeychainAdmitSyntheticWithoutOwnerAuthorityOrProviderGrant() async throws {
        cleanup()
        defer { cleanup() }
        let current = "Apple SDK current application password"
        let retired = "Apple SDK selected retired password"
        let created = try nativeGateCreate(password: retired)
        let rotated = try nativeGateChangePassword(record: created, current: retired, next: current)
        let record = try nativeGateEnroll(record: rotated, current: current, retired: retired,
            synthetic: true, now: "2026-10-06T12:00:00Z")
        try NativeGateStorage.replaceRecord(expected: nil, next: record)
        let admission = WalletAdmission()
        admission.start()
        await admission.unlock(retired)
        guard case .synthetic = admission.session else {
            Issue.record("Selected retired password did not enter the synthetic realm")
            return
        }
        #expect(throws: NativeRealmError.self) { try admission.requireReal() }
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
        admission.observeDenied()
        let observed = try #require(try NativeGateStorage.read("record"))
        let metadata = try nativeGateStatus(record: observed)
        #expect(metadata.contains("synthetic_decoy_interaction"))
        #expect(!metadata.contains(current) && !metadata.contains(retired))
        admission.lock()
        #expect(admission.session == .locked)
        #expect(throws: NativeRealmError.self) { try admission.requireReal() }
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
    }

    @Test func coldProvidersAlwaysDenyAndGrantsAreConsumedOnceThenRevoked() throws {
        cleanup()
        defer { cleanup() }
        try NativeGateStorage.clearPresentationGrant()
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
        // Tests issue a fixture grant directly; production issues it only after
        // fresh application + OS owner authentication. No runtime bypass exists.
        try NativeGateStorage.authorizePresentation()
        let grant = try NativeGateStorage.consumePresentationGrant()
        try NativeGateStorage.requirePresentation(grant)
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
        try NativeGateStorage.clearPresentationGrant()
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.requirePresentation(grant) }
    }

    @Test func concurrentProvidersCannotBothConsumeOneActualKeychainGrant() async throws {
        cleanup()
        defer { cleanup() }
        try NativeGateStorage.clearPresentationGrant()
        try NativeGateStorage.authorizePresentation()
        let successes = await withTaskGroup(of: Bool.self, returning: Int.self) { group in
            for _ in 0..<2 {
                group.addTask { (try? NativeGateStorage.consumePresentationGrant()) != nil }
            }
            var count = 0
            for await success in group { if success { count += 1 } }
            return count
        }
        #expect(successes == 1)
    }

    @Test func expiredAndMalformedGrantsFailClosed() throws {
        cleanup()
        defer { cleanup() }
        try NativeGateStorage.clearPresentationGrant()
        let generation = try #require(try NativeGateStorage.read("presentation-generation"))
        try NativeGateStorage.write("presentation-grant", "\(generation)|\(Date().timeIntervalSince1970 - 1)")
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
        try NativeGateStorage.write("presentation-grant", "malformed")
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
    }
}
