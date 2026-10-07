@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import kotlinx.io.bytestring.ByteString
import kotlin.time.Instant
import org.multipaz.storage.Storage
import org.multipaz.storage.StorageTable
import org.multipaz.storage.StorageTableSpec

/** Wrap the encrypted storage as well as every table returned to Multipaz descendants. */
internal class NativeGatedStorage(
    private val delegate: Storage,
    private val authority: NativeSdkAuthority,
) : Storage {
    init { authority.check() }
    override suspend fun getTable(spec: StorageTableSpec): StorageTable = authority.call {
        Table(delegate.getTable(spec))
    }
    override suspend fun purgeExpired() = authority.call { delegate.purgeExpired() }

    private inner class Table(private val raw: StorageTable) : StorageTable {
        override val storage: Storage get() { authority.check(); return this@NativeGatedStorage }
        override suspend fun get(key: String, partitionId: String?): ByteString? =
            authority.call { raw.get(key, partitionId) }
        override suspend fun insert(key: String?, data: ByteString, partitionId: String?, expiration: Instant): String =
            authority.call { raw.insert(key, data, partitionId, expiration) }
        override suspend fun update(key: String, data: ByteString, partitionId: String?, expiration: Instant?) =
            authority.call { raw.update(key, data, partitionId, expiration) }
        override suspend fun delete(key: String, partitionId: String?): Boolean =
            authority.call { raw.delete(key, partitionId) }
        override suspend fun deleteAll() = authority.call { raw.deleteAll() }
        override suspend fun deletePartition(partitionId: String) = authority.call { raw.deletePartition(partitionId) }
        override suspend fun enumerate(partitionId: String?, afterKey: String?, limit: Int): List<String> =
            authority.call { raw.enumerate(partitionId, afterKey, limit) }
        override suspend fun enumerateWithData(partitionId: String?, afterKey: String?, limit: Int): List<Pair<String, ByteString>> =
            authority.call { raw.enumerateWithData(partitionId, afterKey, limit) }
    }
}
