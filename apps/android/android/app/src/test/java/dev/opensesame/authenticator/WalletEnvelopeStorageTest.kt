@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.runBlocking
import kotlinx.io.bytestring.ByteString
import kotlin.time.Clock
import kotlin.time.Instant
import org.junit.Assert.*
import org.junit.Test
import org.multipaz.storage.StorageTableSpec
import org.multipaz.storage.ephemeral.EphemeralStorage

/** JVM runs real AES-GCM and Multipaz storage, not AndroidKeyStore hardware claims. */
class WalletEnvelopeStorageTest {
    private class Keys : WalletWrappingKeys {
        val values = mutableMapOf<String, SecretKey>()
        private fun id(context: ByteArray) = java.util.Base64.getEncoder().encodeToString(context)
        override fun existing(context: ByteArray) = values[id(context)]
        override fun getOrCreate(context: ByteArray): SecretKey = values.getOrPut(id(context)) {
            KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }
    private class TestClock : Clock {
        var instant = Instant.fromEpochSeconds(100)
        override fun now() = instant
    }
    private val spec = StorageTableSpec("Credentials", true, true)
    private fun bytes(value: String) = ByteString(value.toByteArray())
    private fun wrapper(raw: EphemeralStorage, keys: Keys, backend: String = "https://customer-a.example", legacy: String? = null) =
        WalletEnvelopeStorage(raw, backend, WalletRecordCipher(keys), legacy)

    @Test fun roundTripReopenAndEveryStorageOperation(): Unit = runBlocking {
        val clock = TestClock()
        val raw = EphemeralStorage(clock)
        val keys = Keys()
        val table = wrapper(raw, keys).getTable(spec)
        assertSame(table.storage.getTable(spec), table)
        table.insert("a", bytes("sdjwt-bearer-canary"), "owner-a", Instant.fromEpochSeconds(110))
        val generated = table.insert(null, bytes("generated-secret"), "owner-a")
        assertTrue(generated.matches(Regex("[A-Za-z0-9_-]+")))
        assertEquals(bytes("sdjwt-bearer-canary"), table.get("a", "owner-a"))
        assertFalse(String(raw.getTable(spec).get("a", "owner-a")!!.toByteArray()).contains("sdjwt-bearer-canary"))
        val reopened = wrapper(EphemeralStorage.deserialize(raw.serialize(), clock), keys).getTable(spec)
        assertEquals(bytes("sdjwt-bearer-canary"), reopened.get("a", "owner-a"))
        val expectedKeys = listOf("a", generated).sorted()
        assertEquals(expectedKeys.take(1), reopened.enumerate("owner-a", null, 1))
        val firstValue = if (expectedKeys.first() == "a") bytes("sdjwt-bearer-canary") else bytes("generated-secret")
        assertEquals(listOf(expectedKeys.first() to firstValue), reopened.enumerateWithData("owner-a", null, 1))
        assertEquals(expectedKeys.drop(1), reopened.enumerate("owner-a", expectedKeys.first(), 1))
        table.update("a", bytes("updated-secret"), "owner-a", null)
        clock.instant = Instant.fromEpochSeconds(111)
        assertNull(table.get("a", "owner-a")) // update retained original expiration
        table.storage.purgeExpired()
        table.insert("b", bytes("secret"), "owner-b")
        assertTrue(table.delete(generated, "owner-a"))
        assertFalse(table.delete(generated, "owner-a"))
        table.deletePartition("owner-b")
        assertTrue(table.enumerate("owner-b").isEmpty())
        table.insert("c", bytes("secret"), "owner-c")
        table.deleteAll()
        assertNull(table.get("c", "owner-c"))
    }

    @Test fun migrationIsBoundedIdempotentAndKeepsDeadlines(): Unit = runBlocking {
        val clock = TestClock()
        val raw = EphemeralStorage(clock)
        val plain = raw.getTable(spec)
        repeat(260) { plain.insert("%03d".format(it), bytes("legacy-bearer-$it"), "owner", Instant.fromEpochSeconds(110)) }
        val keys = Keys()
        val table = wrapper(raw, keys, legacy = "https://customer-a.example").getTable(spec)
        assertEquals(bytes("legacy-bearer-0"), table.get("000", "owner"))
        val first = raw.serialize()
        for ((_, data) in plain.enumerateWithData("owner")) {
            assertTrue(WalletRecordCipher(keys).isEnvelope(data.toByteArray()))
            assertFalse(String(data.toByteArray()).contains("legacy-bearer"))
        }
        assertEquals(260, wrapper(raw, keys).getTable(spec).enumerate("owner").size)
        assertEquals(first, raw.serialize())
        clock.instant = Instant.fromEpochSeconds(111)
        assertNull(table.get("000", "owner"))
        assertTrue(table.enumerate("owner").isEmpty())
    }

    @Test fun customerOwnerAndKeyTransplantsAreRejectedWithoutMintingKeys(): Unit = runBlocking {
        val raw = EphemeralStorage()
        val keys = Keys()
        val table = wrapper(raw, keys).getTable(spec)
        table.insert("same-id", bytes("bearer"), "owner-a")
        val ciphertext = raw.getTable(spec).get("same-id", "owner-a")!!
        table.insert("same-id", bytes("different-owner-bearer"), "owner-b")
        assertEquals(bytes("different-owner-bearer"), table.get("same-id", "owner-b"))
        val oracle = WalletRecordCipher(keys)
        assertFalse(keys.existing(oracle.context("https://customer-a.example", spec.name, "owner-a", "same-id"))!!.encoded.contentEquals(
            keys.existing(oracle.context("https://customer-a.example", spec.name, "owner-b", "same-id"))!!.encoded))
        raw.getTable(spec).update("same-id", ciphertext, "owner-b")
        assertThrows(Exception::class.java) { runBlocking { table.get("same-id", "owner-b") } }
        raw.getTable(spec).insert("other-id", ciphertext, "owner-a")
        assertThrows(Exception::class.java) { runBlocking { table.get("other-id", "owner-a") } }
        assertThrows(Exception::class.java) { runBlocking { wrapper(raw, keys, "https://customer-b.example").getTable(spec).get("same-id", "owner-a") } }
        val missing = Keys()
        assertThrows(Exception::class.java) { runBlocking { wrapper(raw, missing).getTable(spec).get("same-id", "owner-a") } }
        assertTrue(missing.values.isEmpty())
    }

    @Test fun unownedLegacyAndBackendSwitchesFailClosed(): Unit = runBlocking {
        val raw = EphemeralStorage()
        val keys = Keys()
        raw.getTable(spec).insert("old", bytes("legacy-owner-unknown"), "owner")
        val table = wrapper(raw, keys).getTable(spec)
        assertThrows(Exception::class.java) { runBlocking { table.get("old", "owner") } }
        assertEquals(bytes("legacy-owner-unknown"), raw.getTable(spec).get("old", "owner"))
        assertThrows(Exception::class.java) { runBlocking { wrapper(raw, keys, "https://customer-b.example", "https://customer-b.example").getTable(spec) } }
        assertThrows(Exception::class.java) { runBlocking { wrapper(raw, keys, legacy = "https://customer-b.example").getTable(spec).get("old", "owner") } }
        assertEquals(bytes("legacy-owner-unknown"), wrapper(raw, keys, "https://CUSTOMER-A.example:443/", "https://customer-a.example").getTable(spec).get("old", "owner"))
        assertEquals("https://customer-a.example", canonicalWalletBackend("https://CUSTOMER-A.example:443/"))
    }

    @Test fun reopenedPlaintextDowngradeAndMissingKeyUpdatesFailClosed(): Unit = runBlocking {
        val raw = EphemeralStorage()
        val keys = Keys()
        val table = wrapper(raw, keys).getTable(spec)
        table.insert("key", bytes("bearer"), "owner")
        val context = WalletRecordCipher(keys).context("https://customer-a.example", spec.name, "owner", "key")
        keys.values.remove(java.util.Base64.getEncoder().encodeToString(context))
        val before = keys.values.size
        assertThrows(Exception::class.java) { runBlocking { table.update("key", bytes("replacement"), "owner") } }
        assertEquals(before, keys.values.size)
        raw.getTable(spec).update("key", bytes("plaintext-downgrade"), "owner")
        assertThrows(Exception::class.java) { runBlocking { wrapper(raw, keys, legacy = "https://customer-a.example").getTable(spec).get("key", "owner") } }
        assertEquals(bytes("plaintext-downgrade"), raw.getTable(spec).get("key", "owner"))
    }

    @Test fun randomDataKeysAndCiphertextAuthentication() {
        val keys = Keys()
        val cipher = WalletRecordCipher(keys)
        val context = cipher.context("customer", "table", "owner", "key")
        val first = cipher.seal(context, "bearer".toByteArray())
        val second = cipher.seal(context, "bearer".toByteArray())
        assertFalse(first.contentEquals(second))
        fun dataKey(envelope: ByteArray): ByteArray {
            val unwrap = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            unwrap.init(javax.crypto.Cipher.DECRYPT_MODE, keys.existing(context), javax.crypto.spec.GCMParameterSpec(128, envelope.copyOfRange(5, 17)))
            unwrap.updateAAD(envelope.copyOfRange(0, 5) + context + byteArrayOf(1))
            return unwrap.doFinal(envelope.copyOfRange(17, 65))
        }
        val firstKey = dataKey(first)
        val secondKey = dataKey(second)
        assertEquals(32, firstKey.size)
        assertFalse(firstKey.contentEquals(secondKey))
        firstKey.fill(0)
        secondKey.fill(0)
        assertArrayEquals("bearer".toByteArray(), cipher.open(context, first))
        for (position in listOf(4, 5, 17, 64, 65, first.lastIndex)) {
            val tampered = first.clone()
            tampered[position] = (tampered[position].toInt() xor 1).toByte()
            assertThrows(Exception::class.java) { cipher.open(context, tampered) }
        }
        assertThrows(Exception::class.java) { cipher.open(context, first.copyOf(20)) }
        assertFalse(cipher.context("a\u0000b", "c", null, "k").contentEquals(cipher.context("a", "b\u0000c", null, "k")))
        assertFalse(cipher.context("a", "b", null, "k").contentEquals(cipher.context("a", "b", "", "k")))
        for (invalid in listOf("\uD800", "\uDC00")) {
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { cipher.context(invalid, "table", "owner", "key") }
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { cipher.context("namespace", invalid, "owner", "key") }
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { cipher.context("namespace", "table", invalid, "key") }
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { cipher.context("namespace", "table", "owner", invalid) }
        }
    }

    @Test fun malformedLegacyMarkersBlockMigrationAndDuplicateKeysRemainAtomic(): Unit = runBlocking {
        val raw = EphemeralStorage()
        val keys = Keys()
        val table = wrapper(raw, keys).getTable(spec)
        table.insert("existing", bytes("old"), "owner")
        assertThrows(Exception::class.java) { runBlocking { table.insert("existing", bytes("new"), "owner") } }
        assertEquals(bytes("old"), table.get("existing", "owner"))
        raw.getTable(spec).insert("bad", ByteString(byteArrayOf(79, 83, 77, 87, 9)), "other-owner")
        assertThrows(Exception::class.java) { runBlocking { table.get("bad", "other-owner") } }
        assertEquals(ByteString(byteArrayOf(79, 83, 77, 87, 9)), raw.getTable(spec).get("bad", "other-owner"))
        assertThrows(Exception::class.java) { runBlocking { table.update("absent", bytes("new"), "owner") } }
    }
}
