import Foundation
@preconcurrency import Multipaz

/// Returned credentials resolve this wrapper, so saved signing handles cannot outlive admission.
final class NativeGatedSecureArea: NSObject, SecureArea {
    private let delegate: any SecureArea
    private let fence: NativeAuthorityFence
    init(delegate: any SecureArea, fence: NativeAuthorityFence) { self.delegate = delegate; self.fence = fence }
    var identifier: String { delegate.identifier }
    var displayName: String { delegate.displayName }
    var supportedAlgorithms: [Algorithm] { delegate.supportedAlgorithms }
    func __batchCreateKey(numKeys: Int32, createKeySettings: CreateKeySettings,
                        completionHandler: @escaping (BatchCreateKeyResult?, Error?) -> Void) {
        fence.perform({ delegate.__batchCreateKey(numKeys: numKeys, createKeySettings: createKeySettings,
            completionHandler: $0) }, completion: completionHandler)
    }
    func __createKey(alias: String?, createKeySettings: CreateKeySettings,
                   completionHandler: @escaping (KeyInfo?, Error?) -> Void) {
        fence.perform({ delegate.__createKey(alias: alias, createKeySettings: createKeySettings,
            completionHandler: $0) }, completion: completionHandler)
    }
    func __deleteKey(alias: String, completionHandler: @escaping (Error?) -> Void) {
        fence.performVoid({ delegate.__deleteKey(alias: alias, completionHandler: $0) }, completion: completionHandler)
    }
    func __getKeyInfo(alias: String, completionHandler: @escaping (KeyInfo?, Error?) -> Void) {
        fence.perform({ delegate.__getKeyInfo(alias: alias, completionHandler: $0) }, completion: completionHandler)
    }
    func __getKeyInvalidated(alias: String, completionHandler: @escaping (KotlinBoolean?, Error?) -> Void) {
        fence.perform({ delegate.__getKeyInvalidated(alias: alias, completionHandler: $0) }, completion: completionHandler)
    }
    func __keyAgreement(alias: String, otherKey: EcPublicKey, unlockReason: any Reason,
                      completionHandler: @escaping (KotlinByteArray?, Error?) -> Void) {
        fence.perform({ delegate.__keyAgreement(alias: alias, otherKey: otherKey, unlockReason: unlockReason,
            completionHandler: $0) }, completion: completionHandler)
    }
    func __sign(alias: String, dataToSign: KotlinByteArray, unlockReason: any Reason,
              completionHandler: @escaping (EcSignature?, Error?) -> Void) {
        fence.perform({ delegate.__sign(alias: alias, dataToSign: dataToSign, unlockReason: unlockReason,
            completionHandler: $0) }, completion: completionHandler)
    }
}

/// The SDK Platform getter retains its first storage forever; bind a fresh enclave area to admission.
func createNativeSecureArea(storage: any Storage, fence: NativeAuthorityFence) async throws -> NativeGatedSecureArea {
    try fence.withCurrent {}
    let area = try await SecureEnclaveSecureArea.companion.create(storage: storage, partitionId: "default")
    return try fence.withCurrent { NativeGatedSecureArea(delegate: area, fence: fence) }
}
