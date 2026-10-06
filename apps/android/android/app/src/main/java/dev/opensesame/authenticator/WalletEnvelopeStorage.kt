@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import java.security.SecureRandom
import java.util.Base64
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.io.bytestring.ByteString
import kotlin.time.Instant
import org.multipaz.storage.Storage
import org.multipaz.storage.NoRecordStorageException
import org.multipaz.storage.KeyExistsStorageException
import org.multipaz.storage.StorageTable
import org.multipaz.storage.StorageTableSpec

/** Multipaz payloads, including keyless bearer credentials, are never written in the clear. */
class WalletEnvelopeStorage(
    private val delegate: Storage,
    backend: String,
    private val cipher: WalletRecordCipher,
    legacyNamespace: String? = null,
) : Storage {
    private val namespace = canonicalWalletBackend(backend)
    private val authorizedLegacy = legacyNamespace?.let(::canonicalWalletBackend) == namespace
    private var namespaceVerified = false
    private val lock = GLOBAL_LOCK
    private val tables = mutableMapOf<StorageTableSpec, StorageTable>()

    override suspend fun getTable(spec: StorageTableSpec): StorageTable = lock.withLock {
        verifyNamespace()
        val raw = delegate.getTable(spec) // Preserve Multipaz duplicate-spec and schema checks.
        tables[spec] ?: EnvelopeTable(spec, raw).also { tables[spec] = it }
    }
    override suspend fun purgeExpired() = lock.withLock { verifyNamespace(); delegate.purgeExpired() }

    private suspend fun verifyNamespace() {
        if (namespaceVerified) return
        val table = delegate.getTable(NAMESPACE_SPEC)
        val context = cipher.context("opensesame.wallet.installation", NAMESPACE_SPEC.name, null, "backend")
        val existing = table.get("backend")
        if (existing == null) {
            check(!cipher.hasWrappingKey(context)) { "Wallet namespace receipt missing; re-provisioning required" }
            table.insert("backend", ByteString(cipher.seal(context, namespace.toByteArray())))
        } else {
            require(String(cipher.open(context, existing.toByteArray()), Charsets.UTF_8) == namespace) { "Wallet backend change requires re-provisioning" }
        }
        namespaceVerified = true
    }

    companion object {
        private val GLOBAL_LOCK = Mutex()
        private val MIGRATION_SPEC = StorageTableSpec("OpenSesameWalletMigrations", false, false)
        private val NAMESPACE_SPEC = StorageTableSpec("OpenSesameWalletNamespace", false, false)
    }

    private inner class EnvelopeTable(private val spec: StorageTableSpec, private val raw: StorageTable) : StorageTable {
        override val storage: Storage get() = this@WalletEnvelopeStorage
        private val migrated = mutableSetOf<String?>()
        private fun context(key: String, partition: String?) = cipher.context(namespace, spec.name, partition, key)
        private fun sealed(key: String, partition: String?, data: ByteString) = ByteString(cipher.seal(context(key, partition), data.toByteArray()))
        private fun opened(key: String, partition: String?, data: ByteString) = ByteString(cipher.open(context(key, partition), data.toByteArray()))

        /** Complete this partition's bounded migration before returning any application data.
         * Multipaz exposes no transaction/CAS API; all app access shares this mutex and decorator.
         * update with null expiration preserves each row's original deadline. A crash is resumable.
         */
        private suspend fun migrate(partition: String?) {
            if (partition in migrated) return
            val receipts = delegate.getTable(MIGRATION_SPEC)
            val receiptContext = cipher.context("opensesame.wallet.migration.v2:" + namespace, spec.name, partition, "complete")
            val receiptKey = java.security.MessageDigest.getInstance("SHA-256").digest(receiptContext).joinToString("") { "%02x".format(it) }
            val receipt = receipts.get(receiptKey)
            if (receipt == null) check(!cipher.hasWrappingKey(receiptContext)) { "Wallet migration receipt missing" }
            else check(cipher.open(receiptContext, receipt.toByteArray()).contentEquals(byteArrayOf(1))) { "Invalid wallet migration receipt" }
            var after: String? = null
            while (true) {
                val page = raw.enumerateWithData(partition, after, 128)
                if (page.isEmpty()) break
                for ((key, data) in page) {
                    if (cipher.isEnvelope(data.toByteArray())) {
                        opened(key, partition, data) // Unknown, malformed or missing-key envelopes block readiness.
                    } else {
                        check(authorizedLegacy && receipt == null) { "Legacy wallet owner is unverified; re-provision or authorize its original backend" }
                        raw.update(key, sealed(key, partition, data), partition, null)
                    }
                }
                after = page.last().first
            }
            if (receipt == null) receipts.insert(receiptKey, ByteString(cipher.seal(receiptContext, byteArrayOf(1))))
            migrated.add(partition)
        }

        override suspend fun get(key: String, partitionId: String?): ByteString? = lock.withLock {
            migrate(partitionId)
            raw.get(key, partitionId)?.let { opened(key, partitionId, it) }
        }
        override suspend fun insert(key: String?, data: ByteString, partitionId: String?, expiration: Instant): String = lock.withLock {
            migrate(partitionId)
            // Generate before encryption so the final record identifier is authenticated.
            if (key != null) {
                if (raw.get(key, partitionId) != null) throw KeyExistsStorageException("Wallet record exists")
                return@withLock raw.insert(key, sealed(key, partitionId, data), partitionId, expiration)
            }
            insertGenerated(data, partitionId, expiration)
        }
        private suspend fun insertGenerated(data: ByteString, partition: String?, expiration: Instant): String {
            while (true) {
                val key = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
                if (raw.get(key, partition) != null) continue
                try { return raw.insert(key, sealed(key, partition, data), partition, expiration) }
                catch (_: KeyExistsStorageException) { /* Retry an independently generated identifier. */ }
            }
        }
        override suspend fun update(key: String, data: ByteString, partitionId: String?, expiration: Instant?) = lock.withLock {
            migrate(partitionId)
            val existing = raw.get(key, partitionId) ?: throw NoRecordStorageException("Wallet record missing")
            opened(key, partitionId, existing) // Never mint a replacement key for an existing envelope.
            raw.update(key, sealed(key, partitionId, data), partitionId, expiration)
        }
        override suspend fun delete(key: String, partitionId: String?): Boolean = lock.withLock { raw.delete(key, partitionId) }
        override suspend fun deleteAll() = lock.withLock { raw.deleteAll(); migrated.clear() }
        override suspend fun deletePartition(partitionId: String): Unit = lock.withLock { raw.deletePartition(partitionId); migrated.remove(partitionId); Unit }
        override suspend fun enumerate(partitionId: String?, afterKey: String?, limit: Int): List<String> = lock.withLock {
            migrate(partitionId)
            raw.enumerate(partitionId, afterKey, limit)
        }
        override suspend fun enumerateWithData(partitionId: String?, afterKey: String?, limit: Int): List<Pair<String, ByteString>> = lock.withLock {
            migrate(partitionId)
            raw.enumerateWithData(partitionId, afterKey, limit).map { (key, data) -> key to opened(key, partitionId, data) }
        }
    }
}


/** One attestation backend per installation, with equivalent HTTPS URLs sharing a scope. */
fun canonicalWalletBackend(value: String): String {
    val uri = java.net.URI(value)
    require(uri.scheme.equals("https", true) && uri.host != null && uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "Invalid wallet backend" }
    val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
    require(uri.port == -1 || uri.port in 1..65535) { "Invalid wallet backend port" }
    val path = (uri.rawPath ?: "").trimEnd('/')
    return "https://${uri.host.lowercase(java.util.Locale.ROOT)}$port$path"
}
