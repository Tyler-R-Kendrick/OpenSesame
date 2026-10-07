import Foundation
import Darwin
@preconcurrency import Multipaz
import WalletEnvelopeCore

public enum WalletStorageContractError: Error { case keyExists, missingRecord }

/// The pinned suspend bridge accepts only Kotlin cancellation errors; ordinary Swift NSError would abort Kotlin.
private func storageRefusalError() -> Error {
    KotlinCancellationException(message: "Encrypted wallet storage refused the operation.").asError()
}

/// Serializes wrapper operations including migration. Multipaz's Storage API has no transaction API.
actor WalletStorageGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }
}

public final class EnvelopeWalletStorage: NSObject, Storage {
    private let raw: Storage
    fileprivate let namespace: String
    fileprivate let keys: any WalletStorageKeys
    fileprivate let codec: WalletEnvelope
    fileprivate let gate = WalletStorageGate()
    fileprivate let lockPath: String
    fileprivate let allowLegacy: Bool
    public init(raw: Storage, namespace: String, keys: any WalletStorageKeys, lockPath: String, legacyNamespace: String? = nil) {
        self.raw = raw; self.namespace = namespace; self.keys = keys; self.codec = WalletEnvelope(keys: keys)
        self.lockPath = lockPath; self.allowLegacy = legacyNamespace == namespace
    }
    fileprivate func locked<T>(_ operation: @escaping () async throws -> T) async throws -> T {
        await gate.acquire()
        var descriptor: Int32? = nil
        do {
            descriptor = try await Task.detached { () throws -> Int32 in
                let fd = open(self.lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
                guard fd >= 0 else { throw POSIXError(.EIO) }
                guard flock(fd, LOCK_EX) == 0 else { close(fd); throw POSIXError(.EIO) }
                return fd
            }.value
            let result = try await operation()
            if let descriptor { flock(descriptor, LOCK_UN); close(descriptor) }
            await gate.release(); return result
        } catch {
            if let descriptor { flock(descriptor, LOCK_UN); close(descriptor) }
            await gate.release(); throw error
        }
    }
    public func __getTable(spec: StorageTableSpec, completionHandler: @escaping @Sendable (StorageTable?, Error?) -> Void) {
        Task {
            do { completionHandler(try await locked { EnvelopeWalletTable(raw: try await self.raw.getTable(spec: spec), owner: self, name: spec.name) }, nil) }
            catch { completionHandler(nil, storageRefusalError()) }
        }
    }
    public func __purgeExpired(completionHandler: @escaping @Sendable (Error?) -> Void) {
        Task { do { try await locked { try await self.raw.purgeExpired() }; completionHandler(nil) } catch { completionHandler(storageRefusalError()) } }
    }
}

private final class EnvelopeWalletTable: NSObject, StorageTable {
    let raw: StorageTable
    let owner: EnvelopeWalletStorage
    let name: String
    var storage: Storage { owner }
    private var migrated: Set<String?> = []
    init(raw: StorageTable, owner: EnvelopeWalletStorage, name: String) { self.raw = raw; self.owner = owner; self.name = name }
    func scope(_ key: String, _ partition: String?) -> WalletScope {
        WalletScope(namespace: owner.namespace, table: name, partition: partition, key: key)
    }
    func data(_ bytes: ByteString) -> Data {
        Data((0..<bytes.size).map { UInt8(bitPattern: bytes.get(index: $0)) })
    }
    func bytes(_ data: Data) -> ByteString { ByteStringAppleKt.toByteString(data) }
    private func requireKey(_ partition: String?, create: Bool) throws {
        var key = try owner.keys.load(context: scope("", partition).keyContext, create: create)
        defer { key.resetBytes(in: 0..<key.count) }
        guard key.count == 32 else { throw WalletEnvelopeError.missingKey }
    }
    /// Finish all accessible legacy rows before exposing any row in this partition.
    private func migrate(_ partition: String?) async throws {
        if migrated.contains(partition) {
            try requireKey(partition, create: false)
            return
        }
        let context = scope("", partition).keyContext
        let completed = try owner.keys.migrationCompleted(context: context)
        if completed { try requireKey(partition, create: false) }
        var after: String? = nil
        var total = 0
        while true {
            let rows = try await raw.enumerateWithData(partitionId: partition, afterKey: after, limit: 128)
            if rows.isEmpty { break }
            total += rows.count
            guard total <= 100_000 else { throw WalletEnvelopeError.malformed }
            for row in rows {
                guard let key = row.first as String?, let value = row.second else { throw WalletEnvelopeError.malformed }
                let stored = data(value)
                let encrypted: Data
                if completed || !owner.allowLegacy { _ = try owner.codec.open(stored, scope: scope(key, partition)); encrypted = stored }
                else { encrypted = try owner.codec.migrateLegacy(stored, scope: scope(key, partition)) }
                if encrypted != stored { try await raw.update(key: key, data: bytes(encrypted), partitionId: partition, expiration: nil) }
                after = key
            }
        }
        try requireKey(partition, create: !completed)
        try owner.keys.finishMigration(context: context)
        migrated.insert(partition)
    }
    private func run<T>(_ operation: @escaping () async throws -> T, _ completion: @escaping (T?, Error?) -> Void) {
        Task {
            do { completion(try await owner.locked(operation), nil) }
            catch { completion(nil, storageRefusalError()) }
        }
    }
    private func runVoid(_ operation: @escaping () async throws -> Void, _ completion: @escaping (Error?) -> Void) {
        run(operation) { _, error in completion(error) }
    }
    func __get(key: String, partitionId: String?, completionHandler: @escaping @Sendable (ByteString?, Error?) -> Void) {
        run({
            try await self.migrate(partitionId)
            guard let stored = try await self.raw.get(key: key, partitionId: partitionId) else { return nil }
            return try self.bytes(self.owner.codec.open(self.data(stored), scope: self.scope(key, partitionId)))
        }) { (result: ByteString??, error) in completionHandler(result ?? nil, error) }
    }
    func __insert(key: String?, data: ByteString, partitionId: String?, expiration: KotlinInstant, completionHandler: @escaping @Sendable (String?, Error?) -> Void) {
        run({
            try await self.migrate(partitionId)
            let id = key ?? Foundation.UUID().uuidString.replacingOccurrences(of: "-", with: "")
            if try await self.raw.get(key: id, partitionId: partitionId) != nil {
                throw WalletStorageContractError.keyExists
            }
            let sealed = try self.owner.codec.seal(self.data(data), scope: self.scope(id, partitionId))
            return try await self.raw.insert(key: id, data: self.bytes(sealed), partitionId: partitionId, expiration: expiration)
        }, completionHandler)
    }
    func __update(key: String, data: ByteString, partitionId: String?, expiration: KotlinInstant?, completionHandler: @escaping @Sendable (Error?) -> Void) {
        runVoid({
            try await self.migrate(partitionId)
            guard let existing = try await self.raw.get(key: key, partitionId: partitionId) else {
                throw WalletStorageContractError.missingRecord
            }
            _ = try self.owner.codec.open(self.data(existing), scope: self.scope(key, partitionId))
            let sealed = try self.owner.codec.seal(self.data(data), scope: self.scope(key, partitionId))
            try await self.raw.update(key: key, data: self.bytes(sealed), partitionId: partitionId, expiration: expiration)
        }, completionHandler)
    }
    func __delete(key: String, partitionId: String?, completionHandler: @escaping @Sendable (KotlinBoolean?, Error?) -> Void) {
        run({ try await self.raw.delete(key: key, partitionId: partitionId) }, completionHandler)
    }
    func __deleteAll(completionHandler: @escaping @Sendable (Error?) -> Void) {
        runVoid({ try await self.raw.deleteAll(); self.migrated.removeAll() }, completionHandler)
    }
    func __deletePartition(partitionId: String, completionHandler: @escaping @Sendable (Error?) -> Void) {
        runVoid({ try await self.raw.deletePartition(partitionId: partitionId); self.migrated.remove(partitionId) }, completionHandler)
    }
    func __enumerate(partitionId: String?, afterKey: String?, limit: Int32, completionHandler: @escaping @Sendable ([String]?, Error?) -> Void) {
        run({ try await self.migrate(partitionId); return try await self.raw.enumerate(partitionId: partitionId, afterKey: afterKey, limit: limit) }, completionHandler)
    }
    func __enumerateWithData(partitionId: String?, afterKey: String?, limit: Int32, completionHandler: @escaping @Sendable ([KotlinPair<NSString, ByteString>]?, Error?) -> Void) {
        run({
            try await self.migrate(partitionId)
            return try await self.raw.enumerateWithData(partitionId: partitionId, afterKey: afterKey, limit: limit).map { row in
                guard let key = row.first as String?, let value = row.second else { throw WalletEnvelopeError.malformed }
                return KotlinPair(first: key as NSString, second: try self.bytes(self.owner.codec.open(self.data(value), scope: self.scope(key, partitionId))))
            }
        }, completionHandler)
    }
}
