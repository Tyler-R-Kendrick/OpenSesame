import Foundation
@preconcurrency import Multipaz
import WalletEnvelopeCore

public enum WalletStorageFactory {
    public static func keys() throws -> KeychainWalletKeys {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenSesameWalletKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { throw WalletEnvelopeError.invalidScope }
        return KeychainWalletKeys(accessGroup: group)
    }
    public static func namespace(backend: URL) throws -> String {
        guard var parts = URLComponents(url: backend, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { throw WalletEnvelopeError.invalidScope }
        parts.scheme = "https"; parts.host = parts.host?.lowercased()
        if let port = parts.port, !(1...65535).contains(port) { throw WalletEnvelopeError.invalidScope }
        if parts.port == 443 { parts.port = nil }
        while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
        guard let value = parts.string else { throw WalletEnvelopeError.invalidScope }
        return value
    }
    public static func open(root: URL, namespace: String, keys: KeychainWalletKeys) throws -> EnvelopeWalletStorage {
        let filename = "wallet-" + WalletEnvelope.identifier(WalletScope.frame([namespace])) + ".db"
        let legacy = root.appendingPathComponent("wallet.db")
        // Legacy database has no authenticated backend owner. Never silently assign its bearers to a new customer.
        if FileManager.default.fileExists(atPath: legacy.path) { throw WalletEnvelopeError.legacy }
        return EnvelopeWalletStorage(raw: IosStorage(storageFileUrl: root.appendingPathComponent(filename), excludeFromBackup: true), namespace: namespace, keys: keys, lockPath: root.appendingPathComponent(filename + ".lock").path)
    }
}
