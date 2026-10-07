import Foundation
import CryptoKit
@preconcurrency import Multipaz
import WalletEnvelopeCore

/// Public fixture keys use real AES-GCM; this does not stand in for owner authentication or Keychain.
final class NativeSdkFixtureKeys: WalletStorageKeys, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data: Data] = [:]
    private var receipts: Set<Data> = []
    func load(context: Data, create: Bool) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if let value = values[context] { return value }
        guard create else { throw WalletEnvelopeError.missingKey }
        let value = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        values[context] = value; return value
    }
    func migrationCompleted(context: Data) throws -> Bool {
        lock.lock(); defer { lock.unlock() }; return receipts.contains(context)
    }
    func finishMigration(context: Data) throws {
        lock.lock(); defer { lock.unlock() }; receipts.insert(context)
    }
}

struct NativeSdkOutcome<T>: @unchecked Sendable { let value: T?; let error: Error? }
final class NativeSdkResult<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: NativeSdkOutcome<T>?
    private var waiter: CheckedContinuation<NativeSdkOutcome<T>, Never>?
    func complete(_ value: T?, _ error: Error?) {
        lock.lock()
        precondition(result == nil)
        let outcome = NativeSdkOutcome(value: value, error: error)
        result = outcome; let pending = waiter; waiter = nil
        lock.unlock(); pending?.resume(returning: outcome)
    }
    func wait() async -> NativeSdkOutcome<T> {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(returning: result) }
            else { precondition(waiter == nil); waiter = continuation; lock.unlock() }
        }
    }
}

/// Delegates to real IosStorage. Only one actual read's completion may be held for lifecycle tests.
final class NativeSdkObservedStorage: NSObject, Storage, @unchecked Sendable {
    private let raw: any Storage
    private let lock = NSLock()
    private var calls: [String: Int] = [:]
    private var writes = 0
    private var armed: String?
    private var held: (() -> Void)?
    let heldRead = NativeSdkResult<Bool>()
    init(raw: any Storage) { self.raw = raw }
    func tableCalls(_ name: String) -> Int { lock.lock(); defer { lock.unlock() }; return calls[name, default: 0] }
    var inserted: Int { lock.lock(); defer { lock.unlock() }; return writes }
    func arm(_ key: String) { lock.lock(); armed = key; lock.unlock() }
    func releaseHeldRead() {
        lock.lock(); let release = held; held = nil; lock.unlock()
        precondition(release != nil); release?()
    }
    private func countInsert() { lock.lock(); writes += 1; lock.unlock() }
    private func deliver(_ key: String, _ value: ByteString?, _ error: Error?, _ completion: @escaping (ByteString?, Error?) -> Void) {
        lock.lock()
        if armed == key {
            armed = nil; held = { completion(value, error) }; lock.unlock(); heldRead.complete(true, nil)
        } else { lock.unlock(); completion(value, error) }
    }
    func __getTable(spec: StorageTableSpec, completionHandler: @escaping ((any StorageTable)?, Error?) -> Void) {
        lock.lock(); calls[spec.name, default: 0] += 1; lock.unlock()
        raw.__getTable(spec: spec) { table, error in
            completionHandler(table.map { Table(raw: $0, owner: self) }, error)
        }
    }
    func __purgeExpired(completionHandler: @escaping (Error?) -> Void) { raw.__purgeExpired(completionHandler: completionHandler) }
    private final class Table: NSObject, StorageTable {
        let raw: any StorageTable
        let owner: NativeSdkObservedStorage
        var storage: any Storage { owner }
        init(raw: any StorageTable, owner: NativeSdkObservedStorage) { self.raw = raw; self.owner = owner }
        func __get(key: String, partitionId: String?, completionHandler: @escaping (ByteString?, Error?) -> Void) {
            raw.__get(key: key, partitionId: partitionId) { self.owner.deliver(key, $0, $1, completionHandler) }
        }
        func __insert(key: String?, data: ByteString, partitionId: String?, expiration: KotlinInstant, completionHandler: @escaping (String?, Error?) -> Void) {
            owner.countInsert(); raw.__insert(key: key, data: data, partitionId: partitionId, expiration: expiration, completionHandler: completionHandler)
        }
        func __update(key: String, data: ByteString, partitionId: String?, expiration: KotlinInstant?, completionHandler: @escaping (Error?) -> Void) {
            raw.__update(key: key, data: data, partitionId: partitionId, expiration: expiration, completionHandler: completionHandler)
        }
        func __delete(key: String, partitionId: String?, completionHandler: @escaping (KotlinBoolean?, Error?) -> Void) {
            raw.__delete(key: key, partitionId: partitionId, completionHandler: completionHandler)
        }
        func __deleteAll(completionHandler: @escaping (Error?) -> Void) { raw.__deleteAll(completionHandler: completionHandler) }
        func __deletePartition(partitionId: String, completionHandler: @escaping (Error?) -> Void) { raw.__deletePartition(partitionId: partitionId, completionHandler: completionHandler) }
        func __enumerate(partitionId: String?, afterKey: String?, limit: Int32, completionHandler: @escaping ([String]?, Error?) -> Void) {
            raw.__enumerate(partitionId: partitionId, afterKey: afterKey, limit: limit, completionHandler: completionHandler)
        }
        func __enumerateWithData(partitionId: String?, afterKey: String?, limit: Int32, completionHandler: @escaping ([KotlinPair<NSString, ByteString>]?, Error?) -> Void) {
            raw.__enumerateWithData(partitionId: partitionId, afterKey: afterKey, limit: limit, completionHandler: completionHandler)
        }
    }
}
