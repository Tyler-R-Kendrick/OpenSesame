import Foundation
import LocalAuthentication
import Security

/// Include this file in both the application and document-provider targets.
/// Both signed targets use the same explicit Keychain access group entitlement.
enum NativeGateStorage {
    private static let service = "dev.opensesame.native-admission.v1"
    private static let recordLock = NSLock()
    static let observationAccount = "credential-observations.v1"
    private static func limit(_ account: String) -> Int { account == observationAccount ? 131_072 : 65_536 }
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func read(_ account: String) throws -> String? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              data.count <= limit(account), let text = String(data: data, encoding: .utf8) else {
            throw NativeStorageError.unavailable
        }
        return text
    }
    static func write(_ account: String, _ value: String) throws {
        let data = Data(value.utf8)
        guard data.count <= limit(account) else { throw NativeStorageError.unavailable }
        let request = query(account)
        let updated = SecItemUpdate(request as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecItemNotFound {
            var insert = request
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw NativeStorageError.unavailable }
        } else if updated != errSecSuccess { throw NativeStorageError.unavailable }
    }
    /// Reject a stale KDF result instead of overwriting another authenticated window's change.
    static func replaceRecord(expected: String?, next: String) throws {
        recordLock.lock()
        defer { recordLock.unlock() }
        guard try read("record") == expected else { throw NativeStorageError.unavailable }
        try write("record", next)
    }
    /// No await occurs between compare and publication. A legacy UUID migration may publish its
    /// still-valid gate first; failure publishing detector state cannot revoke the owner's gate.
    static func replaceDetection(expectedGate: String, expectedState: String?, nextGate: String, nextState: String) throws {
        recordLock.lock()
        defer { recordLock.unlock() }
        guard try read("record") == expectedGate, try read(observationAccount) == expectedState else {
            throw NativeStorageError.unavailable
        }
        if nextGate != expectedGate { try write("record", nextGate) }
        try write(observationAccount, nextState)
    }
    /// Dedicated detector transaction has no admission grant or production document capability.
    static func observationTransaction<T>(_ work: (String, String) throws -> (String?, T)) throws -> T {
        recordLock.lock()
        defer { recordLock.unlock() }
        guard let gate = try read("record"), let state = try read(observationAccount) else {
            throw NativeStorageError.unavailable
        }
        let (next, result) = try work(gate, state)
        if let next { try write(observationAccount, next) }
        return result
    }
    static func clearPresentationGrant() throws {
        try write("presentation-generation", UUID().uuidString)
        let status = SecItemDelete(query("presentation-grant") as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeStorageError.unavailable }
    }
    static func ownerProof() async throws {
        let context = LAContext()
        guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Verify OpenSesame wallet owner") else {
            throw NativeStorageError.ownerRequired
        }
    }
    /// A cold provider launch always requires a fresh application admission grant.
    /// The application issues one grant after OS authentication and its password, when configured.
    static func authorizePresentation() throws {
        guard let generation = try read("presentation-generation") else { throw NativeStorageError.unavailable }
        try write("presentation-grant", "\(generation)|\(Date().timeIntervalSince1970 + 30)")
    }
    struct PresentationPermit: Sendable {
        let generation: String?
        let expires: TimeInterval
    }
    static func consumePresentationGrant() throws -> PresentationPermit {
        let generation = try read("presentation-generation")
        guard let text = try read("presentation-grant") else { throw NativeStorageError.ownerRequired }
        let parts = text.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 2, String(parts[0]) == generation, let expires = TimeInterval(parts[1]),
              expires >= Date().timeIntervalSince1970,
              expires <= Date().timeIntervalSince1970 + 30 else { throw NativeStorageError.ownerRequired }
        let status = SecItemDelete(query("presentation-grant") as CFDictionary)
        guard status == errSecSuccess else { throw NativeStorageError.ownerRequired }
        return PresentationPermit(generation: generation, expires: expires)
    }
    static func requirePresentation(_ permit: PresentationPermit) throws {
        guard try read("presentation-generation") == permit.generation,
              Date().timeIntervalSince1970 <= permit.expires else { throw NativeStorageError.ownerRequired }
    }
}

enum NativeStorageError: Error {
    case unavailable
    case ownerRequired
}
