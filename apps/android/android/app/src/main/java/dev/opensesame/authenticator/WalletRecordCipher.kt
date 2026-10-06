package dev.opensesame.authenticator

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A platform key is minted only for sealing; opening must never replace a missing key. */
interface WalletWrappingKeys {
    fun existing(context: ByteArray): SecretKey?
    fun getOrCreate(context: ByteArray): SecretKey
}

/** Fresh data keys beneath independent, non-exportable platform wrapping keys. */
class WalletRecordCipher(private val keys: WalletWrappingKeys) {
    private val random = SecureRandom()
    private val magic = byteArrayOf(79, 83, 77, 87, 2)

    fun context(namespace: String, table: String, partition: String?, key: String): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            for (field in listOf("opensesame.wallet.record.v2", namespace, table, partition, key)) {
                if (field == null) out.writeInt(-1) else {
                    val encoded = Charsets.UTF_8.newEncoder()
                        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                        .encode(java.nio.CharBuffer.wrap(field))
                    val text = ByteArray(encoded.remaining()).also { encoded.get(it) }
                    out.writeInt(text.size)
                    out.write(text)
                }
            }
        }
        return bytes.toByteArray()
    }

    fun hasWrappingKey(context: ByteArray): Boolean = keys.existing(context) != null

    fun isEnvelope(data: ByteArray): Boolean = data.size >= 4 && data.take(4) == magic.take(4)

    fun seal(context: ByteArray, plaintext: ByteArray): ByteArray {
        val raw = ByteArray(32).also(random::nextBytes)
        try {
            val wrapped = encrypt(keys.getOrCreate(context), magic + context + byteArrayOf(1), raw)
            val body = encrypt(SecretKeySpec(raw, "AES"), magic + context + byteArrayOf(2), plaintext)
            return magic + wrapped + body
        } finally { raw.fill(0) }
    }

    fun open(context: ByteArray, envelope: ByteArray): ByteArray {
        require(envelope.size >= 5 + 12 + 48 + 12 + 16 && envelope.copyOfRange(0, 5).contentEquals(magic)) {
            "Invalid wallet envelope"
        }
        val wrapping = keys.existing(context) ?: throw IllegalStateException("Wallet wrapping key missing")
        val raw = decrypt(wrapping, magic + context + byteArrayOf(1), envelope.copyOfRange(5, 65))
        try {
            require(raw.size == 32) { "Invalid wallet data key" }
            return decrypt(SecretKeySpec(raw, "AES"), magic + context + byteArrayOf(2), envelope.copyOfRange(65, envelope.size))
        } finally { raw.fill(0) }
    }

    private fun encrypt(key: SecretKey, aad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // AndroidKeyStore generates the IV itself; passing an IV would weaken its policy.
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(aad)
        require(cipher.iv.size == 12) { "Unexpected wallet nonce length" }
        return cipher.iv + cipher.doFinal(plaintext)
    }

    private fun decrypt(key: SecretKey, aad: ByteArray, sealed: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
        cipher.updateAAD(aad)
        return cipher.doFinal(sealed.copyOfRange(12, sealed.size))
    }
}

class AndroidWalletWrappingKeys : WalletWrappingKeys {
    companion object { private val KEY_LOCK = Any() }
    private val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun alias(context: ByteArray) = "opensesame.wallet.v2." +
        MessageDigest.getInstance("SHA-256").digest(context).joinToString("") { "%02x".format(it) }

    override fun existing(context: ByteArray): SecretKey? = synchronized(KEY_LOCK) { store.getKey(alias(context), null) as? SecretKey }

    override fun getOrCreate(context: ByteArray): SecretKey = synchronized(KEY_LOCK) {
        existing(context)?.let { return@synchronized it }
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
            alias(context), android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        generator.generateKey()
    }
}
