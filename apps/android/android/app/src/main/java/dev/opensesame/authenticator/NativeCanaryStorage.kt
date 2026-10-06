package dev.opensesame.authenticator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Independent authenticated OS records. Never wallet plaintext or a wallet root. */
internal object NativeCanaryStorage {
    const val GATE = "opensesame.native-admission.v1"
    private const val CANARY = "opensesame.native-observations.v1"
    data class Snapshot(val gate: String?, val state: String?, val sealedGate: String?, val sealedState: String?)

    private fun key(account: String): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(account, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(account, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    private fun open(account: String, encoded: String?, limit: Int): String? {
        if (encoded == null) return null
        check(encoded.length <= ((limit + 28 + 2) / 3) * 4) { "Protected record exceeds its bound" }
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        check(bytes.size in 28..(limit + 28)) { "Invalid protected record" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(account), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
        val clear = cipher.doFinal(bytes.copyOfRange(12, bytes.size))
        return try {
            check(clear.size <= limit)
            clear.toString(Charsets.UTF_8)
        } finally { clear.fill(0) }
    }
    private fun seal(account: String, record: String, limit: Int): String {
        val clear = record.toByteArray(Charsets.UTF_8)
        try {
            check(clear.size <= limit) { "Protected record exceeds its bound" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(account))
            cipher.updateAAD(account.toByteArray(Charsets.UTF_8))
            return Base64.encodeToString(cipher.iv + cipher.doFinal(clear), Base64.NO_WRAP)
        } finally { clear.fill(0) }
    }
    fun snapshot(context: Context): Snapshot {
        val prefs = context.getSharedPreferences(GATE, Context.MODE_PRIVATE)
        val gate = prefs.getString("record", null)
        val state = prefs.getString("observations", null)
        return Snapshot(open(GATE, gate, 65536), open(CANARY, state, 131072), gate, state)
    }
    /** Called only under NativeGate's mutex and original owner permit exclusion. */
    fun commit(context: Context, original: Snapshot, gate: String?, state: String?) {
        val prefs = context.getSharedPreferences(GATE, Context.MODE_PRIVATE)
        check(prefs.getString("record", null) == original.sealedGate &&
            prefs.getString("observations", null) == original.sealedState) { "Protected records changed" }
        val sealedGate = gate?.let { seal(GATE, it, 65536) }
        val sealedState = state?.let { seal(CANARY, it, 131072) }
        val editor = prefs.edit()
        if (sealedGate == null) editor.remove("record") else editor.putString("record", sealedGate)
        if (sealedState == null) editor.remove("observations") else editor.putString("observations", sealedState)
        check(editor.commit()) { "Protected records could not be committed" }
    }
    fun readGate(context: Context): String? = open(GATE,
        context.getSharedPreferences(GATE, Context.MODE_PRIVATE).getString("record", null), 65536)
    fun saveGate(context: Context, gate: String) {
        val prefs = context.getSharedPreferences(GATE, Context.MODE_PRIVATE)
        check(prefs.edit().putString("record", seal(GATE, gate, 65536)).commit())
    }
}
