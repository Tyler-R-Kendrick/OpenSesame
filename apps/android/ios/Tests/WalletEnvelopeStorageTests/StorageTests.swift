import Foundation
import XCTest
import CryptoKit
@preconcurrency import Multipaz
import WalletEnvelopeCore
@testable import WalletEnvelopeStorage

final class FixtureKeys: WalletStorageKeys, @unchecked Sendable {
    var values: [Data: Data] = [:]
    var receipts: Set<Data> = []
    func load(context: Data, create: Bool) throws -> Data {
        if let value = values[context] { return value }
        guard create else { throw WalletEnvelopeError.missingKey }
        let value = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        values[context] = value; return value
    }
    func migrationCompleted(context: Data) throws -> Bool { receipts.contains(context) }
    func finishMigration(context: Data) throws { receipts.insert(context) }
}

final class StorageTests: XCTestCase {
    let namespace = "https://customer-a.example"
    let spec = StorageTableSpec(name: "TestCredentials", supportPartitions: true, supportExpiration: true, schemaVersion: 0)
    func bytes(_ data: Data) -> ByteString { ByteStringAppleKt.toByteString(data) }
    func data(_ bytes: ByteString?) -> Data? {
        bytes.map { value in Data((0..<value.size).map { UInt8(bitPattern: value.get(index: $0)) }) }
    }
    func fixture() throws -> (URL, IosStorage, FixtureKeys, EnvelopeWalletStorage) {
        // Multipaz exposes no close operation; let simulator teardown remove these UUID fixtures after handles exit.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(Foundation.UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let raw = IosStorage(storageFileUrl: root.appendingPathComponent("wallet.db"), excludeFromBackup: true)
        let keys = FixtureKeys()
        let storage = EnvelopeWalletStorage(raw: raw, namespace: namespace, keys: keys, lockPath: root.appendingPathComponent("lock").path)
        return (root, raw, keys, storage)
    }
    func testActualSqliteGenerationEnumerationPartitionsDeleteAndReopen() async throws {
        let encoded = try WalletStorageFactory.namespace(backend: URL(string: "https://tenant.example/tenant%2Fa/")!)
        let literal = try WalletStorageFactory.namespace(backend: URL(string: "https://tenant.example/tenant/a/")!)
        XCTAssertNotEqual(encoded, literal)
        XCTAssertEqual(encoded, "https://tenant.example/tenant%2Fa")
        XCTAssertEqual(try WalletStorageFactory.namespace(backend: URL(string: "HTTPS://TENANT.EXAMPLE:443/tenant%2Fa/")!), encoded)
        XCTAssertThrowsError(try WalletStorageFactory.namespace(backend: URL(string: "https://tenant.example:0/")!))
        XCTAssertThrowsError(try WalletStorageFactory.namespace(backend: URL(string: "https://tenant.example:65536/")!))
        let (root, raw, keys, storage) = try fixture()
        let table = try await storage.getTable(spec: spec)
        let plain = Data("keyless-sdjwt-bearer-and-PII".utf8)
        let future = KotlinInstant.companion.DISTANT_FUTURE
        _ = try await table.insert(key: "a", data: bytes(plain), partitionId: "first", expiration: future)
        _ = try await table.insert(key: "z", data: bytes(plain), partitionId: "first", expiration: future)
        let generated = try await table.insert(key: nil, data: bytes(plain), partitionId: "first", expiration: future)
        XCTAssertFalse(generated.isEmpty)
        XCTAssertTrue(generated.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
        let opened = try await table.get(key: generated, partitionId: "first")
        XCTAssertEqual(data(opened), plain)
        let rawTable = try await raw.getTable(spec: spec)
        let stored = try await rawTable.get(key: generated, partitionId: "first")
        XCTAssertNotEqual(data(stored), plain)
        XCTAssertTrue(data(stored)!.starts(with: WalletEnvelope.marker))
        let all = try await table.enumerate(partitionId: "first", afterKey: nil, limit: Int32.max)
        XCTAssertEqual(all, ["a", generated, "z"].sorted())
        let page = try await table.enumerate(partitionId: "first", afterKey: "a", limit: 1)
        XCTAssertEqual(page, Array(all.filter { $0 > "a" }.prefix(1)))
        let pairs = try await table.enumerateWithData(partitionId: "first", afterKey: nil, limit: 128)
        XCTAssertEqual(pairs.count, 3)
        XCTAssertTrue(pairs.allSatisfy { data($0.second) == plain })
        _ = try await table.insert(key: "a", data: bytes(Data([9])), partitionId: "second", expiration: future)
        XCTAssertEqual(keys.values.count, 2)
        try await table.update(key: generated, data: bytes(Data([7])), partitionId: "first", expiration: nil)
        let reopenedRaw = IosStorage(storageFileUrl: root.appendingPathComponent("wallet.db"), excludeFromBackup: true)
        let reopened = EnvelopeWalletStorage(raw: reopenedRaw, namespace: namespace, keys: keys, lockPath: root.appendingPathComponent("lock").path)
        let reopenedTable = try await reopened.getTable(spec: spec)
        let reopenedValue = try await reopenedTable.get(key: generated, partitionId: "first")
        XCTAssertEqual(data(reopenedValue), Data([7]))
        let deleted = try await table.delete(key: "z", partitionId: "first")
        XCTAssertTrue(deleted.boolValue)
        try await table.deletePartition(partitionId: "first")
        let remaining = try await table.enumerate(partitionId: "first", afterKey: nil, limit: 128)
        XCTAssertTrue(remaining.isEmpty)
        let second = try await table.get(key: "a", partitionId: "second")
        XCTAssertEqual(data(second), Data([9]))
        try await table.deleteAll()
        let empty = try await table.get(key: "a", partitionId: "second")
        XCTAssertNil(empty)
    }
    func testMissingKeyNeverMintsOnCachedUpdateOrDuplicateInsert() async throws {
        let (root, _, keys, storage) = try fixture()
        let table = try await storage.getTable(spec: spec)
        _ = try await table.insert(key: "fixed", data: bytes(Data([1])), partitionId: "part", expiration: KotlinInstant.companion.DISTANT_FUTURE)
        keys.values.removeAll()
        do { try await table.update(key: "fixed", data: bytes(Data([2])), partitionId: "part", expiration: nil); XCTFail("update minted a missing KEK") } catch { }
        XCTAssertTrue(keys.values.isEmpty)
        do { _ = try await table.insert(key: "fixed", data: bytes(Data([2])), partitionId: "part", expiration: KotlinInstant.companion.DISTANT_FUTURE); XCTFail("duplicate accepted") } catch { }
        XCTAssertTrue(keys.values.isEmpty)
    }
    func testEmptyPartitionCreatesOneKeyAndCachedInsertCannotReplaceLostKey() async throws {
        let (root, raw, keys, storage) = try fixture()
        let table = try await storage.getTable(spec: spec)
        let empty = try await table.enumerate(partitionId: "fresh", afterKey: nil, limit: 128)
        XCTAssertTrue(empty.isEmpty)
        XCTAssertEqual(keys.values.count, 1)
        XCTAssertEqual(keys.receipts.count, 1)
        _ = try await table.insert(key: "first", data: bytes(Data([1])), partitionId: "fresh", expiration: KotlinInstant.companion.DISTANT_FUTURE)
        let first = try await table.get(key: "first", partitionId: "fresh")
        XCTAssertEqual(data(first), Data([1]))
        keys.values.removeAll()
        do {
            _ = try await table.insert(key: "second", data: bytes(Data([2])), partitionId: "fresh", expiration: KotlinInstant.companion.DISTANT_FUTURE)
            XCTFail("cached partition minted a replacement KEK")
        } catch { }
        XCTAssertTrue(keys.values.isEmpty)
        let rawTable = try await raw.getTable(spec: spec)
        let absent = try await rawTable.get(key: "second", partitionId: "fresh")
        XCTAssertNil(absent)
        _ = try await rawTable.delete(key: "first", partitionId: "fresh")
        let nowEmpty = try await rawTable.enumerate(partitionId: "fresh", afterKey: nil, limit: 128)
        XCTAssertTrue(nowEmpty.isEmpty)
        let reopened = EnvelopeWalletStorage(raw: raw, namespace: namespace, keys: keys, lockPath: root.appendingPathComponent("lock").path)
        let reopenedTable = try await reopened.getTable(spec: spec)
        do {
            _ = try await reopenedTable.insert(key: "third", data: bytes(Data([3])), partitionId: "fresh", expiration: KotlinInstant.companion.DISTANT_FUTURE)
            XCTFail("receipt minted a replacement KEK")
        } catch { }
        XCTAssertTrue(keys.values.isEmpty)
        let thirdAbsent = try await rawTable.get(key: "third", partitionId: "fresh")
        XCTAssertNil(thirdAbsent)
    }
    func testExplicitMigrationPreservesTTLAndReopenedReceiptRejectsPlaintext() async throws {
        let (root, raw, keys, _) = try fixture()
        let rawTable = try await raw.getTable(spec: spec)
        let expiry = KotlinInstant.companion.fromEpochMilliseconds(epochMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 5000)
        let plain = Data("legacy-bearer".utf8)
        _ = try await rawTable.insert(key: "old", data: bytes(plain), partitionId: "part", expiration: expiry)
        let lockedPath = root.appendingPathComponent("lock").path
        let denied = EnvelopeWalletStorage(raw: raw, namespace: namespace, keys: keys, lockPath: lockedPath)
        let deniedTable = try await denied.getTable(spec: spec)
        do { _ = try await deniedTable.get(key: "old", partitionId: "part"); XCTFail("unowned legacy accepted") } catch { }
        let authorized = EnvelopeWalletStorage(raw: raw, namespace: namespace, keys: keys, lockPath: lockedPath, legacyNamespace: namespace)
        let table = try await authorized.getTable(spec: spec)
        let migrated = try await table.get(key: "old", partitionId: "part")
        XCTAssertEqual(data(migrated), plain)
        try await table.update(key: "old", data: bytes(Data([5])), partitionId: "part", expiration: nil)
        _ = try await rawTable.insert(key: "downgrade", data: bytes(plain), partitionId: "part", expiration: KotlinInstant.companion.DISTANT_FUTURE)
        let reopened = EnvelopeWalletStorage(raw: raw, namespace: namespace, keys: keys, lockPath: lockedPath, legacyNamespace: namespace)
        let reopenedTable = try await reopened.getTable(spec: spec)
        do { _ = try await reopenedTable.get(key: "downgrade", partitionId: "part"); XCTFail("receipt allowed plaintext downgrade") } catch { }
        _ = try await rawTable.delete(key: "downgrade", partitionId: "part")
        try await Task.sleep(nanoseconds: 6_000_000_000)
        let expired = try await table.get(key: "old", partitionId: "part")
        XCTAssertNil(expired)
        try await authorized.purgeExpired()
    }
}
