package dev.opensesame.authenticator

import android.content.Context
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith

/**
 * Requires the disposable CI
 * emulator with real OS PIN 123456 configured by test-android-device.sh.
 * Creates/changes/enrolls/removes records through visible production settings.
 * It never invokes a successful owner callback or writes an enrolled fixture.
 */
@RunWith(AndroidJUnit4::class)
class NativeSettingsDeviceJourneyTest {
    @get:Rule val app = createAndroidComposeRule<MainActivity>()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val storage = "opensesame.native-admission.v1"
    private val first = "UI journey first application password"
    private val second = "UI journey second application password"
    private val current = "UI journey current application password"

    @Before fun emptyFixture() {
        // Reset test state only. Admission and every management operation below
        // use production UI and the actual platform owner factor.
        NativeGate.lock()
        clearFixture()
        app.activityRule.scenario.recreate()
        waitText("Unlock OpenSesame")
    }

    @After fun cleanup() {
        NativeGate.lock()
        clearFixture()
    }

    @Test fun actualSettingsOwnerJourneyRejectsAndDivertsRetiredCredentials() {
        click("Unlock")
        verifyOwnerPin()
        waitText("Security settings")
        click("Security settings")
        field("New application password", first)
        click("Set application password")
        waitOwnerPrompt()
        device.pressBack()
        waitText("Owner verification or operation failed")
        // Cancellation did not arm the gate.
        visible(app.onNodeWithText("Set application password"))
        field("New application password", first)
        click("Set application password")
        verifyOwnerPin()
        waitText("Selected traps: 0/3")
        capture("security-empty", "Selected traps: 0/3")

        rotate(first, second)
        field("Current application password", second)
        field("Selected retired password", first)
        capture("enrollment-default", "Enroll selected retired password")
        activate(app.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)))
        click("Enroll selected retired password")
        verifyOwnerPin()
        waitText("Selected traps: 1/3")
        visible(app.onNodeWithText("Trap 1: Record and reject"))
        capture("reject-enrolled", "Trap 1: Record and reject")

        rotate(second, current)
        field("Current application password", current)
        field("Selected retired password", second)
        activate(app.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)))
        click("Enroll selected retired password")
        verifyOwnerPin()
        waitText("Selected traps: 2/3")
        visible(app.onNodeWithText("Trap 2: Synthetic decoy"))
        capture("synthetic-enrolled", "Trap 2: Synthetic decoy")
        backAndLock()

        submit(first)
        waitText("Wallet could not be unlocked")
        assertEquals(NativeSession.Locked, NativeGate.session)
        app.onNodeWithText("Security settings").assertDoesNotExist()
        app.onNodeWithText("Example membership · member@example.invalid").assertDoesNotExist()
        assertFalse(device.hasObject(ownerCredentialField()))
        capture("reject-result", "Wallet could not be unlocked")

        submit(second)
        waitText("Example membership · member@example.invalid")
        assertTrue(NativeGate.session is NativeSession.Synthetic)
        app.onNodeWithText("Security settings").assertDoesNotExist()
        assertFalse(device.hasObject(ownerCredentialField()))
        capture("synthetic-realm", "Example membership · member@example.invalid")
        click("Lock")
        waitText("Unlock OpenSesame")
        assertEquals(NativeSession.Locked, NativeGate.session)

        submit(current)
        waitOwnerPrompt()
        device.pressBack()
        waitText("Wallet could not be unlocked")
        assertEquals(NativeSession.Locked, NativeGate.session)
        submit(current)
        verifyOwnerPin()
        waitText("Security settings")
        click("Security settings")
        waitText("Selected traps: 2/3")
        waitText("Local observations: 2/32")
        capture("fresh-owner", "Local observations: 2/32")

        field("Current application password", current)
        click("Remove trap 1")
        verifyOwnerPin()
        waitText("Selected traps: 1/3")
        field("Current application password", current)
        click("Clear local evidence")
        verifyOwnerPin()
        waitText("Local observations: 0/32")
        field("Current application password", current)
        click("Remove trap 1")
        verifyOwnerPin()
        waitText("Selected traps: 0/3")
        capture("revoked", "Selected traps: 0/3")
        backAndLock()
        submit(second)
        waitText("Wallet could not be unlocked")
        assertEquals(NativeSession.Locked, NativeGate.session)
        capture("revoked-rejected", "Wallet could not be unlocked")
        submit(current)
        verifyOwnerPin()
        waitText("Security settings")
    }

    private fun rotate(old: String, next: String) {
        field("Current application password", old)
        field("New application password", next)
        click("Change application password")
        verifyOwnerPin()
    }
    private fun capture(name: String, label: String) {
        NativeVisualCapture.capture(app.activity, name, visible(app.onNodeWithText(label)))
    }
    private fun clearFixture() {
        app.activity.getSharedPreferences(storage, Context.MODE_PRIVATE).edit().clear().commit()
    }
    private fun field(label: String, value: String) {
        val node = visible(app.onNode(hasSetTextAction() and hasText(label)))
        node.performTextClearance()
        node.performTextInput(value)
    }
    private fun click(label: String) {
        activate(app.onNodeWithText(label))
    }
    private fun activate(node: SemanticsNodeInteraction) {
        app.waitUntil(30_000) {
            !node.fetchSemanticsNode().config.contains(SemanticsProperties.Disabled)
        }
        visible(node).assertIsEnabled().performClick()
    }
    private fun visible(node: SemanticsNodeInteraction): SemanticsNodeInteraction {
        // Scroll only when the actual semantics ancestry offers scrolling.
        // No scrolling/assertion exception is caught or ignored.
        var parent = node.fetchSemanticsNode().parent
        while (parent != null) {
            if (parent.config.contains(SemanticsActions.ScrollBy)) {
                node.performScrollTo()
                break
            }
            parent = parent.parent
        }
        return node.assertIsDisplayed()
    }
    private fun submit(value: String) {
        field("Application password", value)
        click("Unlock")
    }
    private fun backAndLock() {
        click("Back")
        waitText("Security settings")
        click("Lock")
        waitText("Unlock OpenSesame")
    }
    private fun waitText(text: String) {
        app.waitUntil(30_000) {
            app.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }
    }
    // API 35 SystemUI's actual credential editor, not an application title or lockscreen PIN field.
    private fun ownerPromptResources() = device.findObjects(By.pkg("com.android.systemui"))
        .take(16).joinToString { it.resourceName ?: it.className }
    private fun ownerCredentialField() = By.res("com.android.systemui", "lockPassword").pkg("com.android.systemui")
    private fun waitOwnerPrompt() {
        val shown = device.wait(Until.hasObject(ownerCredentialField()), 30_000)
        assertTrue("Management must show actual OS credential editor; resource IDs: ${if (shown) "present" else ownerPromptResources()}", shown)
    }
    private fun verifyOwnerPin() {
        waitOwnerPrompt()
        checkNotNull(device.findObject(ownerCredentialField())).click()
        device.executeShellCommand("input text 123456")
        device.executeShellCommand("input keyevent 66")
        assertTrue("Owner prompt must finish", device.wait(Until.gone(ownerCredentialField()), 30_000))
        // Completion is subsequently asserted from the visible operation result.
    }
}
