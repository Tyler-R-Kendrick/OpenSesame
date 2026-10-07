import ExtensionKit
import IdentityDocumentServices
import IdentityDocumentServicesUI
@preconcurrency import Multipaz
import WalletEnvelopeCore
import WalletEnvelopeStorage

private enum DocumentProviderError: Error {
    case missingAppGroup
}

private func presentmentSource() async throws -> PresentmentSource {
    try await NativeGateStorage.ownerProof()
    let permit = try NativeGateStorage.consumePresentationGrant()
    let fence = NativeAuthorityFence(denied: {
        CancellationException(message: "Wallet presentation admission ended", cause: nil).asError()
    }, validate: { try NativeGateStorage.requirePresentation(permit) })
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenSesameAppGroup") as? String,
          let root = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group
    ) else { throw DocumentProviderError.missingAppGroup }
    let storage = try fence.withCurrent {
        let keys = try WalletStorageFactory.keys()
        let namespace = try keys.selectedNamespace()
        let envelope = try WalletStorageFactory.open(root: root, namespace: namespace, keys: keys,
            decorateRaw: { NativeGatedStorage(delegate: $0, fence: fence) })
        return NativeGatedStorage(delegate: envelope, fence: fence)
    }
    let secureArea = try await createNativeSecureArea(storage: storage, fence: fence)
    try NativeGateStorage.requirePresentation(permit)
    let secureAreas = SecureAreaRepository.Builder().add(secureArea: secureArea).build()
    let documents = DocumentStore.Builder(
        storage: storage,
        secureAreaRepository: secureAreas
    ).build()
    let documentTypes = DocumentTypeRepository()
    documentTypes.addKnownTypes(locale: LocalizedStrings.shared.getCurrentLocale())
    let source = SimplePresentmentSource.companion.create(
        documentStore: documents,
        documentTypeRepository: documentTypes,
        zkSystemRepository: nil,
        resolveTrustFn: { _ in
            guard (try? NativeGateStorage.requirePresentation(permit)) != nil else { return nil }
            return nil
        },
        showConsentPromptFn: { requester, identity, consent, selected, focused in
            guard (try? NativeGateStorage.requirePresentation(permit)) != nil else { return nil }
            do {
                let result = try await promptModelRequestConsent(
                    requester: requester,
                    trustedRequesterIdentity: identity,
                    consentData: consent,
                    preselectedDocuments: selected,
                    onDocumentsInFocus: {
                        if (try? NativeGateStorage.requirePresentation(permit)) != nil { focused($0) }
                    }
                )
                guard (try? NativeGateStorage.requirePresentation(permit)) != nil else { return nil }
                return result
            } catch { return nil }
        },
        preferSignatureToKeyAgreement: true,
        domainsMdocSignature: ["mdoc_user_auth"],
        domainsMdocKeyAgreement: [],
        domainsKeylessSdJwt: [],
        domainsKeyBoundSdJwt: ["sdjwt_user_auth"]
    )
    return NativeGatedPresentmentSource(delegate: source, fence: fence)
}

@main
struct OpenSesameDocumentProvider: IdentityDocumentProvider {
    var body: some IdentityDocumentRequestScene {
        ISO18013MobileDocumentRequestScene { context in
            RequestAuthorizationView(
                requestContext: context,
                getPresentmentSource: { try await presentmentSource() }
            )
        }
    }

    func performRegistrationUpdates() async {}
}
