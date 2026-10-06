#if canImport(Security)
import Foundation
import Security

/// App and provider must carry the same explicit keychain-access-groups entitlement.
public final class KeychainWalletKeys: WalletStorageKeys, @unchecked Sendable {
    private let group: String
    private let service = "dev.opensesame.wallet.envelopes.v1"
    public init(accessGroup: String) { self.group = accessGroup }
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: group]
    }
    private func read(_ account: String) throws -> Data? {
        var q = query(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return data
    }
    private func insert(_ value: Data, account: String) throws {
        var q = query(account); q[kSecValueData as String] = value
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    public func load(context: Data, create: Bool) throws -> Data {
        let account = "kek:" + WalletEnvelope.identifier(context)
        if let data = try read(account) { return data }
        guard create else { throw WalletEnvelopeError.missingKey }
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        do { try insert(bytes, account: account); return bytes }
        catch let error as NSError where error.code == Int(errSecDuplicateItem) {
            guard let winner = try read(account) else { throw WalletEnvelopeError.missingKey }
            return winner
        }
    }
    public func migrationCompleted(context: Data) throws -> Bool {
        try read("migrated:" + WalletEnvelope.identifier(context)) == Data([1])
    }
    public func finishMigration(context: Data) throws {
        do { try insert(Data([1]), account: "migrated:" + WalletEnvelope.identifier(context)) }
        catch let error as NSError where error.code == Int(errSecDuplicateItem) { }
    }
    public func selectedNamespace() throws -> String {
        guard let data = try read("selected-namespace"), let value = String(data: data, encoding: .utf8), !value.isEmpty else { throw WalletEnvelopeError.invalidScope }
        return value
    }
    public func select(namespace: String) throws {
        let data = Data(namespace.utf8)
        let status = SecItemUpdate(query("selected-namespace") as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound { try insert(data, account: "selected-namespace") }
        else if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}
#endif
