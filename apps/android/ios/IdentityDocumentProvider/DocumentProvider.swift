import ExtensionKit
import IdentityDocumentServices
import IdentityDocumentServicesUI
@preconcurrency import Multipaz

private enum DocumentProviderError: Error {
    case missingAppGroup
}

private func presentmentSource() async throws -> PresentmentSource {
    try await NativeGateStorage.ownerProof()
    let permit = try NativeGateStorage.consumePresentationGrant()
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenSesameAppGroup") as? String,
          let root = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group
    ) else { throw DocumentProviderError.missingAppGroup }
    let storage = IosStorage(
        storageFileUrl: root.appendingPathComponent("wallet.db"),
        excludeFromBackup: true
    )
    let secureArea = try await Platform.shared.getSecureArea(storage: storage)
    try NativeGateStorage.requirePresentation(permit)
    let secureAreas = SecureAreaRepository.Builder().add(secureArea: secureArea).build()
    let documents = DocumentStore.Builder(
        storage: storage,
        secureAreaRepository: secureAreas
    ).build()
    let documentTypes = DocumentTypeRepository()
    documentTypes.addKnownTypes(locale: LocalizedStrings.shared.getCurrentLocale())
    return SimplePresentmentSource.companion.create(
        documentStore: documents,
        documentTypeRepository: documentTypes,
        zkSystemRepository: nil,
        resolveTrustFn: { _ in
            try NativeGateStorage.requirePresentation(permit)
            return nil
        },
        showConsentPromptFn: { requester, identity, consent, selected, focused in
            try NativeGateStorage.requirePresentation(permit)
            let result = try await promptModelRequestConsent(
                requester: requester,
                trustedRequesterIdentity: identity,
                consentData: consent,
                preselectedDocuments: selected,
                onDocumentsInFocus: {
                    if (try? NativeGateStorage.requirePresentation(permit)) != nil { focused($0) }
                }
            )
            try NativeGateStorage.requirePresentation(permit)
            return result
        },
        preferSignatureToKeyAgreement: true,
        domainsMdocSignature: ["mdoc_user_auth"],
        domainsMdocKeyAgreement: [],
        domainsKeylessSdJwt: [],
        domainsKeyBoundSdJwt: ["sdjwt_user_auth"]
    )
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
