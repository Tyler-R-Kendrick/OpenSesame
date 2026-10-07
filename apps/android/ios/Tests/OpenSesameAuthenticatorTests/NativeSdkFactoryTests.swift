import Foundation
@preconcurrency import Multipaz
import Testing
@testable import OpenSesameAuthenticator

@Suite("Fresh pinned SDK secure-area factories")
@MainActor
struct NativeSdkFactoryTests {
    @Test(.timeLimit(.minutes(1))) func freshSdkFactoryRebindsStorageAndStoredSoftwareKeyAfterOwnerLock() async throws {
        // Simulator cannot prove Secure Enclave signing. Its genuine factory storage binding is still observable.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(Foundation.UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent("sdk.db")
        let firstRaw = NativeSdkObservedStorage(raw: IosStorage(storageFileUrl: url, excludeFromBackup: true))
        let state = NativeRealmState()
        try state.admitReal(state.lock())
        let firstFence = try state.authorityFence(state.requireReal(), denied: cancellation)
        let first = NativeGatedStorage(delegate: firstRaw, fence: firstFence)
        let enclave = try await createNativeSecureArea(storage: first, fence: firstFence)
        #expect(firstRaw.tableCalls("SecureEnclaveSecureArea") == 1)
        let bytes = KotlinByteArray(size: 1); bytes.set(index: 0, value: 19)
        let value = ByteString(data: bytes, startIndex: 0, endIndex: 1)
        let software = NativeGatedSecureArea(delegate: try await SoftwareSecureArea.companion.create(storage: first), fence: firstFence)
        let settings = CreateKeySettings(algorithm: .esp256, nonce: value, userAuthenticationRequired: false,
            userAuthenticationTimeout: 0, validFrom: nil, validUntil: nil)
        let key = try await software.createKey(alias: "public-software-fixture", createKeySettings: settings)
        let signature = try await software.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared)
        try await Crypto.shared.checkSignature(publicKey: key.publicKey, message: bytes, algorithm: .esp256, signature: signature)
        state.lock()
        await expectCancellation { _ = try await software.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared) }
        await expectCancellation { _ = try await createNativeSecureArea(storage: first, fence: firstFence) }
        try state.admitReal(state.lock())
        let secondRaw = NativeSdkObservedStorage(raw: IosStorage(storageFileUrl: url, excludeFromBackup: true))
        let freshFence = try state.authorityFence(state.requireReal(), denied: cancellation)
        let fresh = NativeGatedStorage(delegate: secondRaw, fence: freshFence)
        let freshEnclave = try await createNativeSecureArea(storage: fresh, fence: freshFence)
        #expect(enclave !== freshEnclave)
        #expect(secondRaw.tableCalls("SecureEnclaveSecureArea") == 1) // Cached Platform getter would never touch this storage.
        let reopened = NativeGatedSecureArea(delegate: try await SoftwareSecureArea.companion.create(storage: fresh), fence: freshFence)
        let positive = try await reopened.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared)
        try await Crypto.shared.checkSignature(publicKey: key.publicKey, message: bytes, algorithm: .esp256, signature: positive)
        await expectCancellation { _ = try await software.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared) }
        // SDK IosStorage exposes no close; simulator teardown removes these UUID fixture databases.
    }
    private var cancellation: @Sendable () -> Error {
        { CancellationException(message: "SDK fixture admission ended", cause: nil).asError() }
    }
    private func expectCancellation(_ operation: () async throws -> Void) async {
        do { try await operation(); Issue.record("Retained SDK handle survived admission") }
        catch { #expect((error as NSError).kotlinException is KotlinCancellationException) }
    }
}
