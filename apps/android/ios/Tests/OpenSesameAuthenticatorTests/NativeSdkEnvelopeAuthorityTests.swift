import Foundation
@preconcurrency import Multipaz
import Testing
import WalletEnvelopeCore
import WalletEnvelopeStorage
@testable import OpenSesameAuthenticator

@Suite("Encrypted SDK queue authority")
@MainActor
struct NativeSdkEnvelopeAuthorityTests {
    @Test(.timeLimit(.minutes(1))) func queuedEncryptedSdkWriteCannotDispatchAfterLockAndFreshAdmission() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(Foundation.UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let raw = IosStorage(storageFileUrl: root.appendingPathComponent("sdk.db"), excludeFromBackup: true)
        let observed = NativeSdkObservedStorage(raw: raw)
        let keys = NativeSdkFixtureKeys()
        let state = NativeRealmState()
        try state.admitReal(state.lock())
        let fence = try state.authorityFence(state.requireReal(), denied: cancellation)
        let inner = NativeGatedStorage(delegate: observed, fence: fence)
        let envelope = EnvelopeWalletStorage(raw: inner, namespace: "https://sdk-fixture.invalid", keys: keys,
            lockPath: root.appendingPathComponent("sdk.lock").path)
        let storage = NativeGatedStorage(delegate: envelope, fence: fence)
        let spec = StorageTableSpec(name: "HeldSdk", supportPartitions: false, supportExpiration: false, schemaVersion: 0)
        let table = try await storage.getTable(spec: spec)
        let bytes = KotlinByteArray(size: 1); bytes.set(index: 0, value: 42)
        let value = ByteString(data: bytes, startIndex: 0, endIndex: 1)
        _ = try await table.insert(key: "held", data: value, partitionId: nil, expiration: KotlinInstant.companion.DISTANT_FUTURE)
        #expect(try await table.get(key: "held", partitionId: nil) == value)
        let baselineWrites = observed.inserted
        observed.arm("held")
        let read = NativeSdkResult<ByteString>()
        table.__get(key: "held", partitionId: nil) { read.complete($0, $1) }
        #expect(await observed.heldRead.wait().value == true)
        let queued = NativeSdkResult<String>()
        // The real envelope queues its Task behind the held SQLite read; no permission verdict is mocked.
        table.__insert(key: "late", data: value, partitionId: nil,
                       expiration: KotlinInstant.companion.DISTANT_FUTURE) { queued.complete($0, $1) }
        state.lock()
        try state.admitReal(state.lock())
        observed.releaseHeldRead()
        let oldRead = await read.wait()
        let oldWrite = await queued.wait()
        #expect(oldRead.value == nil && oldWrite.value == nil)
        #expect((oldRead.error as NSError?)?.kotlinException is KotlinCancellationException)
        #expect((oldWrite.error as NSError?)?.kotlinException is KotlinCancellationException)
        #expect(observed.inserted == baselineWrites)
        let rawTable = try await raw.getTable(spec: spec)
        #expect(try await rawTable.get(key: "late", partitionId: nil) == nil)
        let freshFence = try state.authorityFence(state.requireReal(), denied: cancellation)
        let freshEnvelope = EnvelopeWalletStorage(raw: NativeGatedStorage(delegate: observed, fence: freshFence),
            namespace: "https://sdk-fixture.invalid", keys: keys, lockPath: root.appendingPathComponent("sdk.lock").path)
        let fresh = NativeGatedStorage(delegate: freshEnvelope, fence: freshFence)
        let freshTable = try await fresh.getTable(spec: spec)
        _ = try await freshTable.insert(key: "fresh", data: value, partitionId: nil, expiration: KotlinInstant.companion.DISTANT_FUTURE)
        #expect(try await freshTable.get(key: "fresh", partitionId: nil) == value)
        let stored = try await rawTable.get(key: "fresh", partitionId: nil)
        #expect(stored != nil)
        #expect(stored != value) // Actual AES-GCM envelope, never a plaintext storage replacement.
        // SDK IosStorage has no close; these disposable UUID files are removed by simulator teardown.
    }
    private var cancellation: @Sendable () -> Error {
        { CancellationException(message: "Encrypted SDK fixture admission ended", cause: nil).asError() }
    }
}
