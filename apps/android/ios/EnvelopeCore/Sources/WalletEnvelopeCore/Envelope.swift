import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum WalletEnvelopeError: Error { case malformed, missingKey, unsupported, legacy, invalidScope }

/// Trusted context comes from the configured backend and Storage API arguments, never a ciphertext header.
public struct WalletScope: Sendable {
    public let namespace: String
    public let table: String
    public let partition: String?
    public let key: String
    public init(namespace: String, table: String, partition: String?, key: String) {
        self.namespace = namespace; self.table = table; self.partition = partition; self.key = key
    }
    public var keyContext: Data { Self.frame(["opensesame.ios.wallet.kek.v1", namespace, table, partition]) }
    public var authenticatedContext: Data { Self.frame(["opensesame.ios.wallet.record.v1", namespace, table, partition, key]) }
    public static func frame(_ parts: [String?]) -> Data {
        var out = Data()
        for part in parts {
            guard let part else { out.append(0); continue }
            out.append(1)
            let bytes = Data(part.utf8)
            var size = UInt64(bytes.count).bigEndian
            withUnsafeBytes(of: &size) { out.append(contentsOf: $0) }
            out.append(bytes)
        }
        return out
    }
}

public protocol WalletKeyProvider: Sendable {
    /// Read must never mint a replacement for a missing key.
    func load(context: Data, create: Bool) throws -> Data
}

public protocol WalletStorageKeys: WalletKeyProvider {
    func migrationCompleted(context: Data) throws -> Bool
    func finishMigration(context: Data) throws
}

public struct WalletEnvelope: Sendable {
    public static let marker = Data("OSIOSW1\0".utf8)
    private static let family = Data("OSIOSW".utf8)
    private let keys: any WalletKeyProvider
    public init(keys: any WalletKeyProvider) { self.keys = keys }
    public static func isEnvelope(_ value: Data) -> Bool { value.starts(with: family) }
    public static func identifier(_ context: Data) -> String {
        SHA256.hash(data: context).map { String(format: "%02x", $0) }.joined()
    }
    public func seal(_ plain: Data, scope: WalletScope) throws -> Data {
        var root = try keys.load(context: scope.keyContext, create: true)
        guard root.count == 32 else { throw WalletEnvelopeError.missingKey }
        defer { root.resetBytes(in: 0..<root.count) }
        let dek = SymmetricKey(size: .bits256)
        var raw = dek.withUnsafeBytes { Data($0) }
        defer { raw.resetBytes(in: 0..<raw.count) }
        let aad = Self.marker + scope.authenticatedContext
        let wrapped = try AES.GCM.seal(raw, using: SymmetricKey(data: root), authenticating: aad)
        guard let packed = wrapped.combined else { throw WalletEnvelopeError.malformed }
        let header = Self.marker + packed
        let payload = try AES.GCM.seal(plain, using: dek, authenticating: aad + header)
        guard let body = payload.combined else { throw WalletEnvelopeError.malformed }
        return header + body
    }
    public func open(_ value: Data, scope: WalletScope) throws -> Data {
        guard Self.isEnvelope(value) else { throw WalletEnvelopeError.legacy }
        guard value.starts(with: Self.marker) else { throw WalletEnvelopeError.unsupported }
        let headerLength = Self.marker.count + 60
        guard value.count >= headerLength + 28 else { throw WalletEnvelopeError.malformed }
        var root = try keys.load(context: scope.keyContext, create: false)
        guard root.count == 32 else { throw WalletEnvelopeError.missingKey }
        defer { root.resetBytes(in: 0..<root.count) }
        let aad = Self.marker + scope.authenticatedContext
        let wrapped = try AES.GCM.SealedBox(combined: value.subdata(in: Self.marker.count..<headerLength))
        var raw = try AES.GCM.open(wrapped, using: SymmetricKey(data: root), authenticating: aad)
        guard raw.count == 32 else { throw WalletEnvelopeError.malformed }
        defer { raw.resetBytes(in: 0..<raw.count) }
        let body = try AES.GCM.SealedBox(combined: value.subdata(in: headerLength..<value.count))
        return try AES.GCM.open(body, using: SymmetricKey(data: raw), authenticating: aad + value.prefix(headerLength))
    }
    /// Called only by the bounded migration pass, never by normal reads.
    public func migrateLegacy(_ value: Data, scope: WalletScope) throws -> Data {
        if Self.isEnvelope(value) { _ = try open(value, scope: scope); return value }
        return try seal(value, scope: scope)
    }
}
