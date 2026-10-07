@file:OptIn(kotlin.time.ExperimentalTime::class)

package dev.opensesame.authenticator

import android.app.KeyguardManager
import android.content.Context
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.File
import org.multipaz.crypto.Algorithm
import org.multipaz.crypto.Crypto
import org.multipaz.document.DocumentStore
import org.multipaz.mdoc.credential.MdocCredential
import org.multipaz.securearea.AndroidKeystoreSecureArea
import org.multipaz.securearea.CreateKeySettings
import org.multipaz.securearea.SecureAreaRepository
import org.multipaz.storage.android.AndroidStorage
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import uniffi.opensesame_authenticator_core.*

/** Real app, Rust/JNA, Keystore AES-GCM and OS owner prompts; no production auth bypass. */
@RunWith(AndroidJUnit4::class)
class NativeAdmissionDeviceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val storage = "opensesame.native-admission.v1"
    private val current = "device-test current application password"
    private val retired = "device-test retired application password"

    @Before fun fixture() {
        NativeGate.lock()
        val created = nativeGateCreate(retired)
        val rotated = nativeGateChangePassword(created, retired, current)
        val enrolled = nativeGateEnroll(rotated, current, retired, true, "2026-10-06T12:00:00Z")
        // Test APK only: prepare a selected trap under the real production
        // Keystore encryption boundary without adding a bypass to the app.
        NativeGate.javaClass.getDeclaredMethod("save", Context::class.java, String::class.java)
            .apply { isAccessible = true }.invoke(NativeGate, app.activity, enrolled)
        app.activityRule.scenario.recreate()
        app.waitUntil(30_000) { app.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size == 1 }
    }

    @After fun cleanup() {
        NativeGate.lock()
        app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun retiredPasswordUsesSyntheticAndBothRealProvidersRefuseIt() {
        submit(retired)
        app.waitUntil(30_000) { NativeGate.session is NativeSession.Synthetic }
        app.onNodeWithText("Example membership · member@example.invalid").assertIsDisplayed()
        app.onNodeWithText("Security settings").assertDoesNotExist()
        assertThrows(IllegalStateException::class.java) { WalletRuntime.provisioningModel }
        assertThrows(IllegalStateException::class.java) { WalletRuntime.presentmentSource }
        denyProviders()
        app.waitUntil(10_000) { status().getJSONArray("events").length() >= 2 }
        assertTrue(status().toString().contains("synthetic_decoy_interaction"))
        assertFalse(status().toString().contains(retired))
        app.onNodeWithText("Lock").performClick()
        app.waitUntil(10_000) { NativeGate.session == NativeSession.Locked }
        denyProviders()
    }

    @Test fun currentPasswordCannotSkipActualOwnerPromptAndCancellationKeepsLocked() {
        submit(current)
        waitOwnerPrompt()
        device.pressBack()
        app.waitUntil(30_000) { app.onAllNodesWithText("Wallet could not be unlocked").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(NativeSession.Locked, NativeGate.session)
        denyProviders()
    }

    @Test fun freshCurrentAndActualDeviceCredentialAdmitRealThenLockRevokesPermit() {
        unlockReal()
        val permit = NativeGate.requireReal()
        app.onNodeWithText("Security settings").assertIsDisplayed()
        assertEquals(1, runBlocking { NativeGate.status(app.activity) }.getJSONArray("traps").length())
        app.onNodeWithText("Lock").performClick()
        app.waitUntil(10_000) { NativeGate.session == NativeSession.Locked }
        assertThrows(IllegalStateException::class.java) { NativeGate.requireSame(permit) }
        denyProviders()
    }

    /** Same production factory and real OS admission, with an isolated persisted SDK fixture database.
     * This does not provision a real issuer or assert hardware backing on the emulator.
     */
    @Test fun actualOwnerReopensSdkSigningKeyWhileRetainedCredentialRemainsRevoked() {
        unlockReal()
        val path = File(app.activity.cacheDir, "sdk-owner-${java.util.UUID.randomUUID()}.db")
        var database = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(path, null)
        var alias: String? = null
        try {
            val first = NativeGate.sdkAuthority(NativeGate.requireReal())
            val storage = NativeGatedStorage(AndroidStorage(database), first)
            val area = runBlocking { withTimeout(10_000) { createNativeSecureArea(storage, first) } }
            val retained = runBlocking { withTimeout(10_000) {
                val documents = DocumentStore.Builder(storage, SecureAreaRepository.Builder().add(area).build()).build()
                val document = documents.createDocument(displayName = "Disposable SDK owner fixture")
                MdocCredential.create(document, null, "mdoc_user_auth", area, "org.iso.18013.5.1.mDL",
                    CreateKeySettings(algorithm = Algorithm.ESP256, userAuthenticationRequired = false))
                document.getPendingCredentials().single() as MdocCredential
            } }
            alias = retained.alias
            val message = byteArrayOf(1, 2, 3)
            val key = runBlocking { withTimeout(10_000) { retained.secureArea.getKeyInfo(retained.alias) } }
            runBlocking { withTimeout(10_000) {
                Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, retained.secureArea.sign(retained.alias, message))
            } }
            app.onNodeWithText("Lock").performClick()
            app.waitUntil(10_000) { NativeGate.session == NativeSession.Locked }
            assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.sign(retained.alias, message) } }
            database.close()
            app.waitUntil(30_000) { app.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size == 1 }
            unlockReal() // A second actual SystemUI PIN ceremony, never a supplied grant.
            database = android.database.sqlite.SQLiteDatabase.openDatabase(path.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE)
            val fresh = NativeGate.sdkAuthority(NativeGate.requireReal())
            val reopened = runBlocking { withTimeout(10_000) {
                createNativeSecureArea(NativeGatedStorage(AndroidStorage(database), fresh), fresh)
            } }
            assertNotSame(area, reopened)
            runBlocking { withTimeout(10_000) {
                assertEquals(key.publicKey, reopened.getKeyInfo(retained.alias).publicKey)
                Crypto.checkSignature(key.publicKey, message, Algorithm.ESP256, reopened.sign(retained.alias, message))
            } }
            assertThrows(IllegalStateException::class.java) { runBlocking { retained.secureArea.sign(retained.alias, message) } }
        } finally {
            if (!database.isOpen) database = android.database.sqlite.SQLiteDatabase.openDatabase(path.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE)
            // Remove only this random fixture's key, including after a failed assertion.
            try { alias?.let { created -> runBlocking { withTimeout(10_000) { AndroidKeystoreSecureArea.create(AndroidStorage(database)).deleteKey(created) } } } }
            finally { database.close(); check(android.database.sqlite.SQLiteDatabase.deleteDatabase(path)) }
        }
    }

    @Test fun staleOwnerKdfResultCannotCommitSetupAfterLock() {
        unlockReal()
        val permit = NativeGate.requireReal()
        val result = nativeGateCreate("completed owner setup derivation")
        val prefs = app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE)
        val before = prefs.getString("record", null)
        NativeGate.lock()
        val failure = assertThrows(java.lang.reflect.InvocationTargetException::class.java) {
            NativeGate.javaClass.getDeclaredMethod("saveOwned", Context::class.java, NativeSession.Real::class.java, String::class.java)
                .apply { isAccessible = true }.invoke(NativeGate, app.activity, permit, result)
        }
        assertTrue(failure.cause is IllegalStateException)
        assertEquals(before, prefs.getString("record", null))
        denyProviders()
    }

    @Test fun authenticatedCiphertextCorruptionFailsClosed() {
        val prefs = app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE)
        val encrypted = checkNotNull(prefs.getString("record", null))
        assertFalse(encrypted.contains(current))
        assertFalse(encrypted.contains(retired))
        val bytes = android.util.Base64.decode(encrypted, android.util.Base64.NO_WRAP)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        prefs.edit().putString("record", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)).commit()
        assertThrows(Exception::class.java) { runBlocking { NativeGate.configured(app.activity) } }
        assertThrows(Exception::class.java) { runBlocking { NativeGate.admit(app.activity, retired) } }
        assertEquals(NativeSession.Locked, NativeGate.session)
        denyProviders()
    }

    private fun submit(password: String) {
        app.onNode(hasSetTextAction()).performTextInput(password)
        app.onNodeWithText("Unlock").performClick()
    }
    private fun unlockReal() {
        submit(current)
        waitOwnerPrompt()
        // Ordinary OS key events against the PIN configured on the disposable
        // emulator, never a mocked successful owner callback.
        checkNotNull(device.findObject(ownerCredentialField())).click()
        device.executeShellCommand("input text 123456")
        device.executeShellCommand("input keyevent 66")
        app.waitUntil(30_000) { NativeGate.session is NativeSession.Real && !device.hasObject(ownerCredentialField()) }
    }
    // API 35 SystemUI's actual credential editor, not an application title or lockscreen PIN field.
    private fun ownerPromptResources() = device.findObjects(By.pkg("com.android.systemui"))
        .take(16).joinToString { it.resourceName ?: it.className }
    private fun ownerCredentialField() = By.res("com.android.systemui", "lockPassword").pkg("com.android.systemui")
    private fun waitOwnerPrompt() {
        val keyguard = app.activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        assertTrue("Disposable test device must have the configured PIN", keyguard.isDeviceSecure)
        val shown = device.wait(Until.hasObject(ownerCredentialField()), 30_000)
        assertTrue("Real admission must present OS credential editor; resource IDs: ${if (shown) "present" else ownerPromptResources()}", shown)
    }
    private fun denyProviders() = app.runOnUiThread {
        assertThrows(IllegalStateException::class.java) { runBlocking { OpenId4VpActivity().getSettings() } }
        assertThrows(IllegalStateException::class.java) { runBlocking { DigitalCredentialsActivity().getSettings() } }
    }
    private fun status(): JSONObject {
        val text = NativeGate.javaClass.getDeclaredMethod("read", Context::class.java)
            .apply { isAccessible = true }.invoke(NativeGate, app.activity) as String
        return JSONObject(nativeGateStatus(text))
    }
}
