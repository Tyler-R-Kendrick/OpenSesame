@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.multipaz.crypto.Algorithm
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcCurve
import org.multipaz.document.DocumentStore
import org.multipaz.mdoc.credential.MdocCredential
import org.multipaz.securearea.CreateKeySettings
import org.multipaz.securearea.SecureArea
import org.multipaz.securearea.SecureAreaRepository
import org.multipaz.securearea.software.SoftwareSecureArea
import org.multipaz.storage.ephemeral.EphemeralStorage

/** Actual SDK credential/key operations and production realm policy; not Android OS factor proof. */
class NativeSdkAuthorityTest {
    private val message = byteArrayOf(1, 2, 3, 4)
    private fun realm() = NativeRealmState().apply { enterReal(lock()) }
    private fun admittedArea(area: SecureArea, realm: NativeRealmState, permit: NativeSession.Real): SecureArea {
        return NativeGatedSecureArea(area, authority(realm, permit))
    }
    private fun authority(realm: NativeRealmState, permit: NativeSession.Real) = NativeSdkAuthority(
        requireCurrent = { realm.requireSame(permit) },
        linearize = { operation -> realm.withSame(permit, operation) },
        subscribe = { callback -> realm.onInvalidated(permit, callback) },
    )
    private suspend fun credential(area: SecureArea, algorithm: Algorithm): MdocCredential {
        val documents = DocumentStore.Builder(EphemeralStorage(), SecureAreaRepository.Builder().add(area).build()).build()
        val document = documents.createDocument(displayName = "SDK lifecycle fixture")
        val created = MdocCredential.create(document = document, asReplacementForIdentifier = null,
            domain = "mdoc_user_auth", secureArea = area, docType = "org.iso.18013.5.1.mDL",
            createKeySettings = CreateKeySettings(algorithm = algorithm, userAuthenticationRequired = false))
        val retained = document.getPendingCredentials().single() as MdocCredential
        assertEquals(created.identifier, retained.identifier)
        return retained
    }
    @Test fun retainedRealSdkCredentialSigningRejectsLockAndFreshSuccessor() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal()
        val raw = SoftwareSecureArea.create(EphemeralStorage())
        val retained = credential(admittedArea(raw, realm, permit), Algorithm.ESP256)
        val key = retained.secureArea.getKeyInfo(retained.alias)
        val positive = retained.secureArea.sign(retained.alias, message)
        Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, positive)
        realm.lock()
        assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.sign(retained.alias, message) } }
        realm.enterReal(realm.lock())
        assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.sign(retained.alias, message) } }
        val fresh = admittedArea(raw, realm, realm.requireReal())
        Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, fresh.sign(retained.alias, message))
    } }
    @Test fun retainedRealSdkCredentialAgreementRejectsLockAndFreshSuccessor() = runBlocking { withTimeout(10000) {
        val realm = realm(); val permit = realm.requireReal()
        val raw = SoftwareSecureArea.create(EphemeralStorage())
        val retained = credential(admittedArea(raw, realm, permit), Algorithm.ECDH_P256)
        val peer = Crypto.createEcPrivateKey(EcCurve.P256)
        val key = retained.secureArea.getKeyInfo(retained.alias)
        val expected = Crypto.keyAgreement(peer, key.publicKey)
        assertArrayEquals(expected, retained.secureArea.keyAgreement(retained.alias, peer.publicKey))
        realm.lock()
        assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.keyAgreement(retained.alias, peer.publicKey) } }
        realm.enterReal(realm.lock())
        assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.keyAgreement(retained.alias, peer.publicKey) } }
        val fresh = admittedArea(raw, realm, realm.requireReal())
        assertArrayEquals(expected, fresh.keyAgreement(retained.alias, peer.publicKey))
    } }
}
