package dev.opensesame.authenticator

import org.multipaz.credential.Credential
import org.multipaz.crypto.EcCurve
import org.multipaz.document.Document
import org.multipaz.document.DocumentBadge
import org.multipaz.document.DocumentStore
import org.multipaz.presentment.ConsentData
import org.multipaz.presentment.CredentialSelection
import org.multipaz.presentment.PresentmentSource
import org.multipaz.request.RequestedClaim
import org.multipaz.request.Requester
import org.multipaz.request.TrustedRequesterIdentity

/** Every provider source belongs to one real admission generation, never a reusable ambient session. */
class GatedPresentmentSource(private val source: PresentmentSource, private val permit: NativeSession.Real) :
    PresentmentSource(source.documentStore, source.documentTypeRepository, source.zkSystemRepository, source.eventLogger) {
    override val documentStore: DocumentStore get() { NativeGate.requireSame(permit); return source.documentStore }
    override suspend fun resolveTrust(requester: Requester): TrustedRequesterIdentity? {
        NativeGate.requireSame(permit)
        val result = source.resolveTrust(requester)
        NativeGate.requireSame(permit)
        return result
    }
    override suspend fun showConsentPrompt(requester: Requester, trustedRequesterIdentity: TrustedRequesterIdentity?,
        consentData: ConsentData, preselectedDocuments: List<Document>, onDocumentsInFocus: (List<Document>) -> Unit): CredentialSelection? {
        NativeGate.requireSame(permit)
        val result = source.showConsentPrompt(requester, trustedRequesterIdentity, consentData, preselectedDocuments) {
            NativeGate.requireSame(permit)
            onDocumentsInFocus(it)
        }
        NativeGate.requireSame(permit)
        return result
    }
    override suspend fun selectCredential(document: Document, requestedClaims: List<RequestedClaim>, keyAgreementPossible: List<EcCurve>): Credential? {
        NativeGate.requireSame(permit)
        val result = source.selectCredential(document, requestedClaims, keyAgreementPossible)
        NativeGate.requireSame(permit)
        return result
    }
    override suspend fun getBadges(document: Document): List<DocumentBadge> {
        NativeGate.requireSame(permit)
        val result = source.getBadges(document)
        NativeGate.requireSame(permit)
        return result
    }
}
