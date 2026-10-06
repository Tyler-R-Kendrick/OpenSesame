import Foundation
import OpenSesameAuthenticatorCore
import Security
import Testing
@testable import OpenSesameAuthenticator

/// Apple SDK/real Keychain + actual Rust bridge tests. Fixture setup never claims OS owner proof.
extension NativeKeychainTests {
    private var canaryNow: String { "2026-10-06T00:00:00.000Z" }
    private func canaryCleanup() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.opensesame.native-admission.v1"] as CFDictionary)
    }
    @Test func actualKeychainDetectionStateIsDeviceOnlyAndRejectsStalePublication() throws {
        canaryCleanup(); defer { canaryCleanup() }
        let gate = try nativeGateCreate(password: "Apple SDK owner test password")
        try NativeGateStorage.replaceRecord(expected: nil, next: gate)
        let created = try nativeCanaryManage(gateRecord: gate, current: "Apple SDK owner test password",
            stateRecord: nil, operation: .create(kind: "mcp_configuration"), now: canaryNow)
        try NativeGateStorage.replaceDetection(expectedGate: gate, expectedState: nil,
            nextGate: created.gateRecord, nextState: created.stateRecord)
        var attributes: CFTypeRef?
        let result = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.opensesame.native-admission.v1",
            kSecAttrAccount as String: NativeGateStorage.observationAccount,
            kSecReturnAttributes as String: true] as CFDictionary, &attributes)
        #expect(result == errSecSuccess)
        #expect((attributes as? [String: Any])?[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        #expect(throws: NativeStorageError.self) {
            try NativeGateStorage.replaceDetection(expectedGate: gate, expectedState: nil,
                nextGate: created.gateRecord, nextState: created.stateRecord)
        }
        #expect(try NativeGateStorage.read(NativeGateStorage.observationAccount) == created.stateRecord)
    }
    @MainActor
    @Test func coldAndSyntheticAppSessionsCannotManageCanariesOrCreateReceiverState() async throws {
        canaryCleanup(); defer { canaryCleanup() }
        let current = "Apple SDK current canary password"
        let retired = "Apple SDK retired canary password"
        let gate = try nativeGateCreate(password: current)
        let enrolled = try nativeGateEnroll(record: gate, current: current, retired: retired,
            synthetic: true, now: canaryNow)
        try NativeGateStorage.replaceRecord(expected: nil, next: enrolled)
        let admission = WalletAdmission(); admission.start()
        await admission.manageCanary(current: current, mutation: .create(kind: "mcp_configuration"))
        #expect(try NativeGateStorage.read(NativeGateStorage.observationAccount) == nil)
        await admission.unlock(retired)
        guard case .synthetic = admission.session else { Issue.record("Synthetic admission failed"); return }
        await admission.manageCanary(current: current, mutation: .create(kind: "mcp_configuration"))
        #expect(try NativeGateStorage.read(NativeGateStorage.observationAccount) == nil)
        #expect(throws: NativeRealmError.self) { try admission.requireReal() }
        #expect(throws: NativeStorageError.self) { try NativeGateStorage.consumePresentationGrant() }
    }
    @Test func actualRustCanaryIdentificationCannotBecomeApplicationAdmission() throws {
        struct Created: Decodable { let id: String; let presentedId: String }
        let gate = try nativeGateCreate(password: "Apple SDK canary owner")
        let created = try nativeCanaryManage(gateRecord: gate, current: "Apple SDK canary owner",
            stateRecord: nil, operation: .create(kind: "mcp_configuration"), now: canaryNow)
        let artifact = try JSONDecoder().decode(Created.self, from: Data(created.output.utf8))
        let observed = try nativeCanaryObserve(gateRecord: created.gateRecord, stateRecord: created.stateRecord,
            artifactId: artifact.id, presentedId: artifact.presentedId, phase: "connected", now: canaryNow)
        #expect(observed.observed)
        #expect(observed.decision.contains("synthetic_readonly"))
        #expect(try nativeGateAdmit(record: created.gateRecord, password: artifact.presentedId, now: canaryNow).realm == .rejected)
        let status = try nativeCanaryStatus(gateRecord: created.gateRecord, stateRecord: observed.stateRecord)
        #expect(!status.contains(artifact.presentedId) && !status.contains("digestB64"))
        #expect(!status.contains("independentKeyMaterialB64"))
    }
    @Test func exactRootIdentityAndCurrentPasswordGuardAllCanaryState() throws {
        let gate = try nativeGateCreate(password: "Apple SDK canary owner")
        let created = try nativeCanaryManage(gateRecord: gate, current: "Apple SDK canary owner",
            stateRecord: nil, operation: .create(kind: "mcp_configuration"), now: canaryNow)
        #expect(throws: (any Error).self) {
            try nativeCanaryManage(gateRecord: gate, current: "wrong owner",
                stateRecord: created.stateRecord, operation: .clearEvents, now: canaryNow)
        }
        let foreign = try nativeGateCreate(password: "Apple SDK canary owner")
        #expect(throws: (any Error).self) {
            try nativeCanaryStatus(gateRecord: foreign, stateRecord: created.stateRecord)
        }
        let rotated = try nativeGateChangePassword(record: gate, current: "Apple SDK canary owner", next: "Apple SDK next owner")
        #expect(try nativeCanaryStatus(gateRecord: rotated, stateRecord: created.stateRecord).contains("mcp_configuration"))
    }
}
