import Foundation
@preconcurrency import Multipaz

/// Every selection, consent handback and table/signing descendant uses the same permit.
final class NativeGatedPresentmentSource: PresentmentSource, @unchecked Sendable {
    private let delegate: PresentmentSource
    private let fence: NativeAuthorityFence
    init(delegate: PresentmentSource, fence: NativeAuthorityFence) {
        self.delegate = delegate
        self.fence = fence
        super.init(documentStore: delegate.documentStore, documentTypeRepository: delegate.documentTypeRepository,
                   zkSystemRepository: delegate.zkSystemRepository, eventLogger: delegate.eventLogger)
    }
    func endAdmission() { fence.revoke() }

    override func __resolveTrust(requester: Requester,
                               completionHandler: @escaping (TrustedRequesterIdentity?, Error?) -> Void) {
        fence.perform({ delegate.__resolveTrust(requester: requester, completionHandler: $0) }, completion: completionHandler)
    }
    override func __getBadges(document: Document, completionHandler: @escaping ([DocumentBadge]?, Error?) -> Void) {
        fence.perform({ delegate.__getBadges(document: document, completionHandler: $0) }, completion: completionHandler)
    }
    override func __selectCredential(document: Document, requestedClaims: [RequestedClaim], keyAgreementPossible: [EcCurve],
                                   completionHandler: @escaping @Sendable (Credential?, Error?) -> Void) {
        fence.perform({ delegate.__selectCredential(document: document, requestedClaims: requestedClaims,
            keyAgreementPossible: keyAgreementPossible, completionHandler: $0) }, completion: completionHandler)
    }
    override func __showConsentPrompt(requester: Requester, trustedRequesterIdentity: TrustedRequesterIdentity?,
                                    consentData: ConsentData, preselectedDocuments: [Document],
                                    onDocumentsInFocus: @escaping ([Document]) -> Void,
                                    completionHandler: @escaping (CredentialSelection?, Error?) -> Void) {
        fence.perform({ delegate.__showConsentPrompt(requester: requester, trustedRequesterIdentity: trustedRequesterIdentity,
            consentData: consentData, preselectedDocuments: preselectedDocuments,
            onDocumentsInFocus: { documents in
                try? self.fence.withCurrent { onDocumentsInFocus(documents) }
            }, completionHandler: $0) }, completion: completionHandler)
    }
}
