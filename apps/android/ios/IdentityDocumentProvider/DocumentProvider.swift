import ExtensionKit
import IdentityDocumentServices
import IdentityDocumentServicesUI
import SwiftUI
@preconcurrency import Multipaz
import WalletEnvelopeCore
import WalletEnvelopeStorage

private enum DocumentProviderError: Error {
    case missingAppGroup
}

private func presentmentSource() async throws -> NativeGatedPresentmentSource {
    try Task.checkCancellation()
    try await NativeGateStorage.ownerProof()
    try Task.checkCancellation()
    let permit = try NativeGateStorage.consumePresentationGrant()
    let fence = NativeAuthorityFence(denied: {
        CancellationException(message: "Wallet presentation admission ended", cause: nil).asError()
    }, validate: { try NativeGateStorage.requirePresentation(permit) })
    var retained = false
    defer { if !retained { fence.revoke() } }
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
            await nativeRequestConsent(requester: requester, identity: identity,
                consent: consent, selected: selected, focused: focused, fence: fence)
        },
        preferSignatureToKeyAgreement: true,
        domainsMdocSignature: ["mdoc_user_auth"],
        domainsMdocKeyAgreement: [],
        domainsKeylessSdJwt: [],
        domainsKeyBoundSdJwt: ["sdjwt_user_auth"]
    )
    try Task.checkCancellation()
    let admitted = NativeGatedPresentmentSource(delegate: source, fence: fence)
    retained = true
    return admitted
}

@main
struct OpenSesameDocumentProvider: IdentityDocumentProvider {
    var body: some IdentityDocumentRequestScene {
        ISO18013MobileDocumentRequestScene { context in
            NativeRequestAdmissionView { source in
                RequestAuthorizationView(
                    requestContext: context,
                    getPresentmentSource: { source }
                )
            }
        }
    }

    func performRegistrationUpdates() async {}
}

/// The SDK's callback cannot throw. Render it only after authentic owner admission.
@MainActor
private struct NativeRequestAdmissionView<Content: View>: View {
    let content: (PresentmentSource) -> Content
    @State private var source: NativeGatedPresentmentSource?
    @State private var denied = false
    @State private var preparationId = Foundation.UUID()

    var body: some View {
        Group {
            if let source {
                content(source)
            } else if denied {
                Text("Owner verification required")
            } else {
                ProgressView("Verify wallet owner")
            }
        }
        .task {
            let expected = preparationId
            denied = false
            var prepared: NativeGatedPresentmentSource?
            do {
                prepared = try await presentmentSource()
                try Task.checkCancellation()
                guard expected == preparationId else {
                    prepared?.endAdmission()
                    return
                }
                source = prepared
            } catch {
                prepared?.endAdmission()
                if expected == preparationId && !Task.isCancelled { denied = true }
            }
        }
        .onDisappear {
            preparationId = Foundation.UUID()
            source?.endAdmission()
            source = nil
        }
    }
}
