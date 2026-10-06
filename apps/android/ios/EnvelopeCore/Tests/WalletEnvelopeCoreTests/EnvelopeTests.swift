import Foundation
import XCTest
@testable import WalletEnvelopeCore
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

final class MemoryKeys: WalletKeyProvider, @unchecked Sendable {
    var values: [Data: Data] = [:]
    private let lock = NSLock()
    func load(context: Data, create: Bool) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if let value = values[context] { return value }
        guard create else { throw WalletEnvelopeError.missingKey }
        let value = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        values[context] = value; return value
    }
}

final class EnvelopeTests: XCTestCase {
    let scope = WalletScope(namespace: "https://customer-a.example", table: "Credentials", partition: "sdjwt", key: "same")
    func dek(_ stored: Data, keys: MemoryKeys) throws -> Data {
        let header = WalletEnvelope.marker.count
        let box = try AES.GCM.SealedBox(combined: stored.subdata(in: header..<header+60))
        return try AES.GCM.open(box, using: SymmetricKey(data: keys.load(context: scope.keyContext, create: false)), authenticating: WalletEnvelope.marker + scope.authenticatedContext)
    }
    func testRandomKeysAndRealEnvelopeOracle() throws {
        let keys = MemoryKeys(); let codec = WalletEnvelope(keys: keys)
        let a = try codec.seal(Data("bearer-secret-and-PII".utf8), scope: scope)
        let b = try codec.seal(Data("bearer-secret-and-PII".utf8), scope: scope)
        XCTAssertNotEqual(a, b)
        XCTAssertNotEqual(try dek(a, keys: keys), try dek(b, keys: keys))
        let start = WalletEnvelope.marker.count + 60
        let payload = try AES.GCM.SealedBox(combined: a.subdata(in: start..<a.count))
        let aad = WalletEnvelope.marker + scope.authenticatedContext + a.prefix(start)
        XCTAssertThrowsError(try AES.GCM.open(payload, using: SymmetricKey(data: keys.load(context: scope.keyContext, create: false)), authenticating: aad))
        XCTAssertEqual(try AES.GCM.open(payload, using: SymmetricKey(data: dek(a, keys: keys)), authenticating: aad), Data("bearer-secret-and-PII".utf8))
    }
    func testIndependentCustomerTablePartitionAndRecordContexts() throws {
        let keys = MemoryKeys(); let codec = WalletEnvelope(keys: keys)
        let stored = try codec.seal(Data([1,2,3]), scope: scope)
        let alternatives = [
            WalletScope(namespace: "https://customer-b.example", table: scope.table, partition: scope.partition, key: scope.key),
            WalletScope(namespace: scope.namespace, table: "Other", partition: scope.partition, key: scope.key),
            WalletScope(namespace: scope.namespace, table: scope.table, partition: nil, key: scope.key),
            WalletScope(namespace: scope.namespace, table: scope.table, partition: scope.partition, key: "other"),
        ]
        for other in alternatives {
            _ = try codec.seal(Data([4]), scope: other)
            XCTAssertThrowsError(try codec.open(stored, scope: other))
        }
        XCTAssertEqual(Set(keys.values.values).count, 4)
        XCTAssertNotEqual(WalletScope.frame(["a\0b","c"]), WalletScope.frame(["a","b\0c"]))
        XCTAssertNotEqual(WalletScope.frame([nil]), WalletScope.frame([""]))
    }
    func testTamperingMissingKeyAndUnknownVersionFailClosed() throws {
        let keys = MemoryKeys(); let codec = WalletEnvelope(keys: keys)
        let stored = try codec.seal(Data([1,2,3]), scope: scope)
        for at in [0,6,8,20,67,68,stored.count-1] {
            var changed = stored; changed[at] ^= 1
            XCTAssertThrowsError(try codec.open(changed, scope: scope))
        }
        XCTAssertThrowsError(try codec.open(Data("OSIOSW2\0".utf8), scope: scope))
        XCTAssertThrowsError(try codec.migrateLegacy(Data("OSIOSW2\0".utf8), scope: scope))
        XCTAssertThrowsError(try codec.open(WalletEnvelope.marker, scope: scope))
        let missing = MemoryKeys()
        XCTAssertThrowsError(try WalletEnvelope(keys: missing).open(stored, scope: scope))
        XCTAssertTrue(missing.values.isEmpty)
    }
    func testPayloadAuthenticatesAValidReplacementWrappedKeyHeader() throws {
        let keys = MemoryKeys(); let codec = WalletEnvelope(keys: keys)
        let stored = try codec.seal(Data([1,2,3]), scope: scope)
        let aad = WalletEnvelope.marker + scope.authenticatedContext
        let wrapped = try AES.GCM.seal(dek(stored, keys: keys), using: SymmetricKey(data: keys.load(context: scope.keyContext, create: false)), authenticating: aad)
        let replaced = WalletEnvelope.marker + wrapped.combined! + stored.dropFirst(WalletEnvelope.marker.count + 60)
        XCTAssertThrowsError(try codec.open(replaced, scope: scope))
    }
    func testExplicitLegacyMigrationAndReopen() throws {
        let keys = MemoryKeys(); let legacy = Data("old-keyless-bearer".utf8)
        let codec = WalletEnvelope(keys: keys)
        XCTAssertThrowsError(try codec.open(legacy, scope: scope))
        let encrypted = try codec.migrateLegacy(legacy, scope: scope)
        XCTAssertNotEqual(encrypted, legacy)
        let reopenedKeys = MemoryKeys()
        reopenedKeys.values = keys.values
        let reopened = WalletEnvelope(keys: reopenedKeys)
        XCTAssertEqual(try reopened.open(encrypted, scope: scope), legacy)
        XCTAssertEqual(try reopened.migrateLegacy(encrypted, scope: scope), encrypted)
    }
}
