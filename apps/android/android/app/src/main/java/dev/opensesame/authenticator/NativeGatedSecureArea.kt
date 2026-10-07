package dev.opensesame.authenticator

import org.multipaz.crypto.Algorithm
import org.multipaz.crypto.EcPublicKey
import org.multipaz.crypto.EcSignature
import org.multipaz.prompt.Reason
import org.multipaz.securearea.AndroidKeystoreSecureArea
import org.multipaz.storage.Storage
import org.multipaz.securearea.BatchCreateKeyResult
import org.multipaz.securearea.CreateKeySettings
import org.multipaz.securearea.KeyInfo
import org.multipaz.securearea.SecureArea

/** Never expose the platform SecureArea through a retained credential's final SDK getter. */
internal class NativeGatedSecureArea(
    private val delegate: SecureArea,
    private val authority: NativeSdkAuthority,
) : SecureArea {
    init { authority.check() }
    override val identifier: String get() { authority.check(); return delegate.identifier }
    override val displayName: String get() { authority.check(); return delegate.displayName }
    override val supportedAlgorithms: List<Algorithm> get() { authority.check(); return delegate.supportedAlgorithms }
    override suspend fun createKey(alias: String?, createKeySettings: CreateKeySettings): KeyInfo =
        authority.call { delegate.createKey(alias, createKeySettings) }
    override suspend fun batchCreateKey(numKeys: Int, createKeySettings: CreateKeySettings): BatchCreateKeyResult =
        authority.call { delegate.batchCreateKey(numKeys, createKeySettings) }
    override suspend fun deleteKey(alias: String) = authority.call { delegate.deleteKey(alias) }
    override suspend fun sign(alias: String, dataToSign: ByteArray, unlockReason: Reason): EcSignature =
        authority.call { delegate.sign(alias, dataToSign, unlockReason) }
    override suspend fun keyAgreement(alias: String, otherKey: EcPublicKey, unlockReason: Reason): ByteArray =
        authority.call { delegate.keyAgreement(alias, otherKey, unlockReason) }
    override suspend fun getKeyInfo(alias: String): KeyInfo = authority.call { delegate.getKeyInfo(alias) }
    override suspend fun getKeyInvalidated(alias: String): Boolean = authority.call { delegate.getKeyInvalidated(alias) }
}

/** Platform.getSecureArea caches the first storage forever; construct for this admitted session. */
internal suspend fun createNativeSecureArea(storage: Storage, authority: NativeSdkAuthority): SecureArea =
    authority.call { NativeGatedSecureArea(AndroidKeystoreSecureArea.create(storage), authority) }
