import ExtensionKit
import IdentityDocumentServices
import IdentityDocumentServicesUI
@preconcurrency import Multipaz

private enum DocumentProviderError: Error {
    case missingAppGroup
}

private func presentmentSource() async throws -> PresentmentSource {
    guard let root = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.dev.opensesame.authenticator"
    ) else { throw DocumentProviderError.missingAppGroup }
    let storage = IosStorage(
        storageFileUrl: root.appendingPathComponent("wallet.db"),
        excludeFromBackup: true
    )
    let secureArea = try await Platform.shared.getSecureArea(storage: storage)
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
        resolveTrustFn: { _ in nil },
        showConsentPromptFn: { requester, identity, consent, selected, focused in
            try await promptModelRequestConsent(
                requester: requester,
                trustedRequesterIdentity: identity,
                consentData: consent,
                preselectedDocuments: selected,
                onDocumentsInFocus: { focused($0) }
            )
        },
        preferSignatureToKeyAgreement: true,
        domainsMdocSignature: ["mdoc_user_auth", "mdoc_no_user_auth"],
        domainsMdocKeyAgreement: [],
        domainsKeylessSdJwt: ["sdjwt_keyless"],
        domainsKeyBoundSdJwt: ["sdjwt_user_auth", "sdjwt_no_user_auth"]
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
