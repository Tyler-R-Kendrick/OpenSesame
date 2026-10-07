@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
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
import org.multipaz.storage.Storage
import org.multipaz.storage.StorageTable
import org.multipaz.storage.StorageTableSpec
import org.multipaz.storage.ephemeral.EphemeralStorage

/** Genuine encrypted migration with a delayed SDK page; no OS wrapping-key assurance is inferred. */
class NativeSdkEnvelopeTest {
    private class Keys : WalletWrappingKeys {
        private val keys = mutableMapOf<String, SecretKey>()
        private fun id(context: ByteArray) = java.util.Base64.getEncoder().encodeToString(context)
        override fun existing(context: ByteArray) = keys[id(context)]
        override fun getOrCreate(context: ByteArray): SecretKey = keys.getOrPut(id(context)) {
            KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }
    private fun authority(realm: NativeRealmState): NativeSdkAuthority {
        val permit = realm.requireReal()
        return NativeSdkAuthority(
            requireCurrent = { realm.requireSame(permit) },
            linearize = { operation -> realm.withSame(permit, operation) },
            subscribe = { callback -> realm.onInvalidated(permit, callback) },
        )
    }

    @Test fun lockedMigrationCannotPublishLateSdkPageOrDispatchDependentWrites() = runBlocking { withTimeout(10000) {
        val realm = NativeRealmState().apply { enterReal(lock()) }
        val raw = EphemeralStorage()
        val targetSpec = StorageTableSpec("LateMigration", false, false)
        val original = ByteString("public-legacy-fixture".toByteArray())
        val plain = raw.getTable(targetSpec)
        plain.insert("fixture", original)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var armed = true
        val delayed = object : Storage by raw {
            override suspend fun getTable(spec: StorageTableSpec): StorageTable {
                val table = raw.getTable(spec)
                if (spec != targetSpec) return table
                return object : StorageTable by table {
                    override suspend fun enumerateWithData(partitionId: String?, afterKey: String?, limit: Int): List<Pair<String, ByteString>> {
                        val page = table.enumerateWithData(partitionId, afterKey, limit)
                        if (armed) withContext(NonCancellable) { entered.complete(Unit); release.await() }
                        return page
                    }
                }
            }
        }
        val cipher = WalletRecordCipher(Keys())
        fun scoped(): NativeGatedStorage {
            val authority = authority(realm)
            return NativeGatedStorage(WalletEnvelopeStorage(NativeGatedStorage(delayed, authority),
                "https://customer.example", cipher, "https://customer.example"), authority)
        }
        val table = scoped().getTable(targetSpec)
        val pending = async { table.get("fixture") }
        try {
            entered.await()
            realm.lock()
            realm.enterReal(realm.lock())
            release.complete(Unit)
            assertThrows(CancellationException::class.java) { runBlocking { pending.await() } }
            assertEquals(original, plain.get("fixture")) // No post-lock migration write.
            armed = false
            assertEquals(original, scoped().getTable(targetSpec).get("fixture"))
            assertTrue(cipher.isEnvelope(plain.get("fixture")!!.toByteArray())) // Fresh owner still migrates.
        } finally { release.complete(Unit); pending.cancel() }
    } }
}
