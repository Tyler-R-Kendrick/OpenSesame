import ExtensionKit
import SwiftUI
import IdentityDocumentServices
import IdentityDocumentServicesUI
@preconcurrency import Multipaz
import WalletEnvelopeCore
import WalletEnvelopeStorage

private enum DocumentProviderError: Error {
    case missingAppGroup
}

private func presentmentSource() async throws -> PresentmentSource {
    guard let root = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: "group.dev.opensesame.authenticator"
    ) else { throw DocumentProviderError.missingAppGroup }
    let keys = try WalletStorageFactory.keys()
    let namespace = try keys.selectedNamespace()
    let storage = try WalletStorageFactory.open(root: root, namespace: namespace, keys: keys)
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
            do {
                return try await promptModelRequestConsent(
                    requester: requester,
                    trustedRequesterIdentity: identity,
                    consentData: consent,
                    preselectedDocuments: selected,
                    onDocumentsInFocus: { focused($0) }
                )
            } catch {
                // Consent failure is refusal; no credential is selected.
                return nil
            }
        },
        preferSignatureToKeyAgreement: true,
        domainsMdocSignature: ["mdoc_user_auth", "mdoc_no_user_auth"],
        domainsMdocKeyAgreement: [],
        domainsKeylessSdJwt: ["sdjwt_keyless"],
        domainsKeyBoundSdJwt: ["sdjwt_user_auth", "sdjwt_no_user_auth"]
    )
}

@MainActor
private struct PreparedAuthorizationView: View {
    let context: ISO18013MobileDocumentRequestContext
    @State private var source: PresentmentSource?
    @State private var unavailable = false

    var body: some View {
        Group {
            if let source {
                RequestAuthorizationView(requestContext: context, getPresentmentSource: { source })
            } else if unavailable {
                ContentUnavailableView("Wallet unavailable", systemImage: "lock", description: Text("Open OpenSesame to check your wallet."))
            } else {
                ProgressView("Opening wallet")
            }
        }
        .task {
            guard source == nil && !unavailable else { return }
            do { source = try await presentmentSource() }
            catch { unavailable = true }
        }
    }
}

@main
struct OpenSesameDocumentProvider: IdentityDocumentProvider {
    var body: some IdentityDocumentRequestScene {
        ISO18013MobileDocumentRequestScene { context in
            PreparedAuthorizationView(context: context)
        }
    }

    func performRegistrationUpdates() async {}
}
