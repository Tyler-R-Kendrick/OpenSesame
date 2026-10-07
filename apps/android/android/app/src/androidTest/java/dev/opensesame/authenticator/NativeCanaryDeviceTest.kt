package dev.opensesame.authenticator

import android.content.Context
import android.util.Base64
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import uniffi.opensesame_authenticator_core.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** Actual Keystore and actual OS PIN proof; no successful owner callback bypass. */
@RunWith(AndroidJUnit4::class)
class NativeCanaryDeviceTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val current = "native canary device owner password"
    private val storage = "opensesame.native-admission.v1"
    private val now = "2026-10-06T12:00:00.000Z"

    @Before fun fixture() {
        unlockInitialDeviceScreen(app.activity, device)
        NativeGate.lock()
        app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE).edit().clear().commit()
        NativeGate.javaClass.getDeclaredMethod("save", Context::class.java, String::class.java)
            .apply { isAccessible = true }.invoke(NativeGate, app.activity, nativeGateCreate(current))
        app.activityRule.scenario.recreate()
        assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED, app.activity.lifecycle.currentState)
        unlockRealFromAdmission()
    }
    @After fun cleanup() {
        NativeGate.lock()
        app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE).edit().clear().commit()
    }
    @Test fun visibleFreshOwnerCanaryCreateAndRevokeKeepsRawIdentifierOutOfUiAndStorage() {
        openSettings()
        password()
        click("Create Connection reference canary")
        ownerPin()
        waitText("Export prepared once. Choose a private file destination.")
        val snapshot = NativeCanaryStorage.snapshot(app.activity)
        val state = JSONObject(checkNotNull(snapshot.state))
        val artifact = state.getJSONObject("registry").getJSONArray("artifacts").getJSONObject(0)
        assertFalse(checkNotNull(snapshot.sealedState).contains(artifact.getString("digestB64")))
        assertFalse(checkNotNull(snapshot.state).contains("presentedId"))
        assertFalse(checkNotNull(snapshot.sealedState).contains(current))
        assertEquals(1, runBlocking { NativeGate.canaryStatus(app.activity) }.getJSONArray("artifacts").length())
        assertFalse(runBlocking { NativeGate.canaryStatus(app.activity) }.toString().contains("independentKeyMaterialB64"))
        password()
        click("Revoke canary 1")
        ownerPin()
        app.waitUntil(30_000) { runBlocking { NativeGate.canaryStatus(app.activity) }.getJSONArray("artifacts").length() == 0 }
    }
    @Test fun cancelActualManagementOwnerPromptDoesNotInstallSecondaryState() {
        openSettings()
        password()
        click("Create Connection reference canary")
        waitOwnerPrompt()
        val cancellation = cancelActualOwnerPrompt(device)
        app.waitUntil(cancellation.remaining()) {
            app.onAllNodesWithText("Owner verification or canary operation failed.").fetchSemanticsNodes().isNotEmpty()
        }
        assertNull(app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE).getString("observations", null))
        cancellation.remaining()
    }
    @Test fun completedOwnerDerivationCannotCommitIntoFreshSameWalletSuccessor() {
        val permit = NativeGate.requireReal()
        val original = NativeCanaryStorage.snapshot(app.activity)
        val result = nativeCanaryManage(checkNotNull(original.gate), current, original.state,
            NativeCanaryMutation.Create("mcp_configuration"), now)
        NativeGate.lock()
        app.activityRule.scenario.recreate()
        unlockRealFromAdmission()
        assertNotEquals(permit, NativeGate.requireReal())
        val successorSnapshot = NativeCanaryStorage.snapshot(app.activity)
        val failure = assertThrows(java.lang.reflect.InvocationTargetException::class.java) {
            NativeGate.javaClass.getDeclaredMethod("commitCanaryOwned", Context::class.java,
                NativeSession.Real::class.java, NativeCanaryStorage.Snapshot::class.java, String::class.java, String::class.java)
                .apply { isAccessible = true }.invoke(NativeGate, app.activity, permit, successorSnapshot, result.gateRecord, result.stateRecord)
        }
        assertTrue(failure.cause is IllegalStateException)
        val after = NativeCanaryStorage.snapshot(app.activity)
        assertEquals(successorSnapshot.sealedGate, after.sealedGate)
        assertEquals(successorSnapshot.sealedState, after.sealedState)
        assertThrows(IllegalStateException::class.java) { NativeGate.requireSame(permit) }
    }
    @Test fun secondaryCiphertextTamperingFailsClosedWithoutBreakingPrimaryAdmissionRecord() {
        installFixtureState()
        val prefs = app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE)
        val primary = prefs.getString("record", null)
        val bytes = Base64.decode(checkNotNull(prefs.getString("observations", null)), Base64.NO_WRAP)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        prefs.edit().putString("observations", Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()
        assertThrows(Exception::class.java) { runBlocking { NativeGate.canaryStatus(app.activity) } }
        assertTrue(runBlocking { NativeGate.configured(app.activity) })
        assertEquals(primary, prefs.getString("record", null))
        NativeGate.lock()
        assertThrows(IllegalStateException::class.java) { runBlocking { NativeGate.canaryStatus(app.activity) } }
    }
    @Test fun compoundCompareAndSwapRejectsChangedProtectedSnapshotAndCrossAccountCiphertext() {
        val original = NativeCanaryStorage.snapshot(app.activity)
        val result = nativeCanaryManage(checkNotNull(original.gate), current, original.state,
            NativeCanaryMutation.Create("mcp_configuration"), now)
        NativeCanaryStorage.commit(app.activity, original, result.gateRecord, result.stateRecord)
        val installed = NativeCanaryStorage.snapshot(app.activity)
        assertThrows(IllegalStateException::class.java) {
            NativeCanaryStorage.commit(app.activity, original, result.gateRecord, result.stateRecord)
        }
        assertEquals(installed.sealedGate, NativeCanaryStorage.snapshot(app.activity).sealedGate)
        val prefs = app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE)
        prefs.edit().putString("observations", installed.sealedGate).commit()
        assertThrows(Exception::class.java) { NativeCanaryStorage.snapshot(app.activity) }
        assertTrue(runBlocking { NativeGate.configured(app.activity) })
    }
    @Test fun normalOwnerPasswordChangeRefusesHeldIssuerResultWithoutChangingRealEpoch() {
        val permit = NativeGate.requireReal()
        val original = NativeCanaryStorage.snapshot(app.activity)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val ref = "b41894cb-4a7d-43c9-a5d2-37a4fd9378bf"
        val provider = object : NativeCanaryIssuerProvider {
            override fun retireAuthenticated(issuerRecordRef: String, expectedVaultIdentity: String): String {
                entered.countDown()
                check(release.await(60, TimeUnit.SECONDS))
                val digest = java.util.Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
                return """{"id":"$issuerRecordRef","context":{"vaultIdentity":"$expectedVaultIdentity","kind":"connection_ref","generation":1},"digestB64":"$digest","state":"retired","createdAt":"$now","retiredAt":"$now"}"""
            }
        }
        val guarded = guardNativeIssuerProvider(checkNotNull(original.gate),
            { NativeCanaryStorage.readGate(app.activity) }, { NativeGate.requireSame(permit) }, provider)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val pending = executor.submit<NativeCanaryOwnerResult> {
                nativeCanaryRetireIssued(checkNotNull(original.gate), current, original.state, ref, guarded, now)
            }
            assertTrue(entered.await(60, TimeUnit.SECONDS))
            val change = CoroutineScope(Dispatchers.Main).async {
                NativeGate.manage(app.activity, current, permit) {
                    nativeGateChangePassword(it, current, "next native owner password")
                }
            }
            ownerPin()
            runBlocking { change.await() }
            NativeGate.requireSame(permit)
            release.countDown()
            val failure = assertThrows(ExecutionException::class.java) { pending.get(60, TimeUnit.SECONDS) }
            assertTrue(failure.cause is NativeGateException)
            assertNull(NativeCanaryStorage.snapshot(app.activity).state)
            assertEquals(NativeRealm.REAL, nativeGateAdmit(checkNotNull(NativeCanaryStorage.readGate(app.activity)),
                "next native owner password", now).realm)
        } finally { release.countDown(); executor.shutdownNow() }
    }
    private fun unlockRealFromAdmission() {
        app.waitUntil(30_000) { app.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size == 1 }
        app.onNode(hasSetTextAction()).performTextInput(current)
        app.onNodeWithText("Unlock").performClick()
        ownerPin()
        app.waitUntil(30_000) { NativeGate.session is NativeSession.Real }
    }
    private fun installFixtureState() {
        val original = NativeCanaryStorage.snapshot(app.activity)
        val result = nativeCanaryManage(checkNotNull(original.gate), current, original.state,
            NativeCanaryMutation.Create("mcp_configuration"), now)
        NativeCanaryStorage.commit(app.activity, original, result.gateRecord, result.stateRecord)
    }
    private fun openSettings() {
        click("Security settings")
        click("Controlled canaries and observation receiver")
        waitText("Security · Decoy · Controlled canaries")
        app.waitUntil(30_000) { !app.onNodeWithText("Create Connection reference canary").fetchSemanticsNode().config.contains(SemanticsProperties.Disabled) ||
            app.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size == 1 }
    }
    private fun password() {
        val field = app.onNode(hasSetTextAction() and hasText("Current application password for canaries"))
        field.performScrollTo().performTextClearance()
        field.performTextInput(current)
    }
    private fun click(label: String) {
        // Security publishes configured controls after its real protected-state read.
        // Await that exact node and enabled state within the existing action budget.
        app.waitUntil(30_000) {
            val nodes = app.onAllNodesWithText(label).fetchSemanticsNodes()
            nodes.size == 1 && !nodes.single().config.contains(SemanticsProperties.Disabled)
        }
        val node = app.onNodeWithText(label)
        if (label == "Security settings") node.assertIsDisplayed()
        else node.performScrollTo().assertIsDisplayed()
        node.performClick()
    }
    private fun waitText(text: String) { app.waitUntil(30_000) { app.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    // API 35 SystemUI's actual credential editor, not an application title or lockscreen PIN field.
    private fun ownerPromptResources() = device.findObjects(By.pkg("com.android.systemui"))
        .take(16).joinToString { it.resourceName ?: it.className }
    private fun ownerCredentialField() = By.res("com.android.systemui", "lockPassword").pkg("com.android.systemui")
    private fun waitOwnerPrompt() {
        val shown = device.wait(Until.hasObject(ownerCredentialField()), 30_000)
        assertTrue("Actual OS credential editor required; resource IDs: ${if (shown) "present" else ownerPromptResources()}", shown)
    }
    private fun ownerPin() {
        waitOwnerPrompt()
        checkNotNull(device.findObject(ownerCredentialField())).click()
        device.executeShellCommand("input text 123456")
        device.executeShellCommand("input keyevent 66")
        assertTrue(device.wait(Until.gone(ownerCredentialField()), 30_000))
    }
}
