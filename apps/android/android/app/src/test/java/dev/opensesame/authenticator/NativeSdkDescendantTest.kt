@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.bytestring.ByteString
import org.junit.Assert.*
import org.junit.Test
import org.multipaz.crypto.Algorithm
import org.multipaz.crypto.Crypto
import org.multipaz.crypto.EcSignature
import org.multipaz.prompt.Reason
import org.multipaz.securearea.CreateKeySettings
import org.multipaz.securearea.SecureArea
import org.multipaz.securearea.software.SoftwareSecureArea
import org.multipaz.storage.Storage
import org.multipaz.storage.StorageTable
import org.multipaz.storage.StorageTableSpec
import org.multipaz.storage.ephemeral.EphemeralStorage

/** Real SDK crypto/storage with controlled suspensions; Android OS factors are tested separately. */
class NativeSdkDescendantTest {
    private val message = byteArrayOf(7, 8, 9)
    private fun realm() = NativeRealmState().apply { enterReal(lock()) }
    private fun authority(realm: NativeRealmState, permit: NativeSession.Real = realm.requireReal()) = NativeSdkAuthority(
        requireCurrent = { realm.requireSame(permit) },
        linearize = { operation -> realm.withSame(permit, operation) },
        subscribe = { callback -> realm.onInvalidated(permit, callback) },
    )

    @Test fun retainedSdkTableRejectsReadWriteAndDeleteAfterLockAndSuccessor() = runBlocking { withTimeout(10000) {
        val realm = realm()
        val raw = EphemeralStorage()
        val guarded = NativeGatedStorage(raw, authority(realm))
        val spec = StorageTableSpec("Retained", false, false)
        val table = guarded.getTable(spec)
        val value = ByteString(byteArrayOf(4, 5, 6))
        table.insert("original", value)
        assertEquals(value, table.get("original"))
        assertEquals(listOf("original"), table.enumerate())
        realm.lock()
        fun refuse(operation: suspend () -> Unit) = assertThrows(IllegalStateException::class.java) { runBlocking { operation() } }
        refuse { table.get("original") }
        refuse { table.update("original", ByteString(byteArrayOf(0))) }
        refuse { table.insert("injected", value) }
        refuse { table.delete("original") }
        refuse { table.deleteAll() }
        refuse { table.deletePartition("partition") }
        refuse { table.enumerate() }
        refuse { table.enumerateWithData() }
        refuse { guarded.purgeExpired() }
        refuse { guarded.getTable(spec) }
        assertThrows(IllegalStateException::class.java) { table.storage }
        realm.enterReal(realm.lock())
        refuse { table.get("original") }
        val fresh = NativeGatedStorage(raw, authority(realm)).getTable(spec)
        assertEquals(listOf("original" to value), fresh.enumerateWithData())
    } }

    @Test fun pendingRealSdkSigningIsCancelledOnLockWithoutReleasingStorage() = runBlocking { withTimeout(10000) {
        val realm = realm()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        var armed = false
        val rawStorage = EphemeralStorage()
        val delayedStorage = object : Storage by rawStorage {
            override suspend fun getTable(spec: StorageTableSpec): StorageTable {
                val table = rawStorage.getTable(spec)
                return object : StorageTable by table {
                    override suspend fun get(key: String, partitionId: String?): ByteString? {
                        if (armed) {
                            entered.complete(Unit)
                            try { release.await() } finally { cancelled.complete(Unit) }
                        }
                        return table.get(key, partitionId)
                    }
                }
            }
        }
        val raw = SoftwareSecureArea.create(delayedStorage)
        val area = NativeGatedSecureArea(raw, authority(realm))
        val key = area.createKey("pending", CreateKeySettings(algorithm = Algorithm.ESP256))
        Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, area.sign("pending", message))
        armed = true
        val pending = async { area.sign("pending", message) }
        try {
            entered.await()
            realm.lock()
            assertThrows(CancellationException::class.java) { runBlocking { pending.await() } }
            cancelled.await()
            assertFalse(release.isCompleted)
        } finally { release.complete(Unit); pending.cancel() }
    } }

    @Test fun completedRealSdkSignatureCannotReturnAfterLockAndFreshSuccessor() = runBlocking { withTimeout(10000) {
        val realm = realm()
        val raw = SoftwareSecureArea.create(EphemeralStorage())
        val key = raw.createKey("late", CreateKeySettings(algorithm = Algorithm.ESP256))
        val signed = CompletableDeferred<EcSignature>()
        val release = CompletableDeferred<Unit>()
        val heldArea = object : SecureArea by raw {
            override suspend fun sign(alias: String, dataToSign: ByteArray, unlockReason: Reason): EcSignature {
                val signature = raw.sign(alias, dataToSign, unlockReason)
                signed.complete(signature)
                return withContext(NonCancellable) { release.await(); signature }
            }
        }
        val area = NativeGatedSecureArea(heldArea, authority(realm))
        val pending = async { area.sign("late", message) }
        try {
            Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, signed.await())
            realm.lock()
            realm.enterReal(realm.lock())
            release.complete(Unit)
            assertThrows(CancellationException::class.java) { runBlocking { pending.await() } }
            val fresh = NativeGatedSecureArea(raw, authority(realm))
            Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, fresh.sign("late", message))
        } finally { release.complete(Unit); pending.cancel() }
    } }

    @Test fun lockedAndSyntheticRealmsCannotAcquireRetainedSdkHandles() = runBlocking { withTimeout(10000) {
        val realm = realm()
        val original = realm.requireReal()
        val raw = SoftwareSecureArea.create(EphemeralStorage())
        val old = authority(realm, original)
        realm.lock()
        assertThrows(IllegalStateException::class.java) { NativeGatedSecureArea(raw, old) }
        assertThrows(IllegalStateException::class.java) { NativeGatedStorage(EphemeralStorage(), old) }
        realm.enterSynthetic(realm.lock())
        assertThrows(IllegalStateException::class.java) { authority(realm, original) }
        assertThrows(IllegalStateException::class.java) { realm.requireReal() }
        realm.enterReal(realm.lock())
        val fresh = NativeGatedSecureArea(raw, authority(realm))
        val key = fresh.createKey("fresh", CreateKeySettings(algorithm = Algorithm.ESP256))
        Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, fresh.sign("fresh", message))
    } }
}
