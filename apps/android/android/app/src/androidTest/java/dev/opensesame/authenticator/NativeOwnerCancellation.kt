package dev.opensesame.authenticator

import android.os.SystemClock
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

/** One original 30s cancellation budget: SystemUI dismissal and application refusal. */
internal class NativeCancellationBudget {
    private val deadline = SystemClock.elapsedRealtime() + 30_000

    fun remaining(): Long {
        val value = deadline - SystemClock.elapsedRealtime()
        check(value > 0) { "Actual owner cancellation deadline expired" }
        return value
    }
}

/** Cancels the genuine OS editor. Never supplies a grant or changes application admission. */
internal fun cancelActualOwnerPrompt(device: UiDevice): NativeCancellationBudget {
    val budget = NativeCancellationBudget()
    val editor = By.res("com.android.systemui", "lockPassword").pkg("com.android.systemui")
    check(device.hasObject(editor)) { "Actual SystemUI owner editor required before cancellation" }
    device.pressBack()
    // The first Back can dismiss the IME while leaving the owner editor open.
    if (!device.wait(Until.gone(editor), minOf(500L, budget.remaining())) && device.hasObject(editor)) {
        device.pressBack()
    }
    check(device.wait(Until.gone(editor), budget.remaining())) {
        "Actual SystemUI owner editor remained after cancellation"
    }
    return budget
}
