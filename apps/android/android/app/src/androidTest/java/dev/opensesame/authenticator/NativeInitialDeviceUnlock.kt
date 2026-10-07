package dev.opensesame.authenticator

import android.app.KeyguardManager
import android.content.Context
import android.os.SystemClock
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

/** Unlocks only the disposable emulator's system screen, never the application's owner gate. */
internal fun unlockInitialDeviceScreen(context: Context, device: UiDevice) {
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    val deadline = SystemClock.elapsedRealtime() + 30_000
    fun remaining(): Long {
        val value = deadline - SystemClock.elapsedRealtime()
        check(value > 0) { "Initial system screen unlock deadline expired" }
        return value
    }
    if (!device.isScreenOn) device.wakeUp()
    println("Native fixture initial keyguardLocked=${keyguard.isKeyguardLocked}")
    if (keyguard.isKeyguardLocked) {
        val pin = By.res("com.android.systemui", "pinEntry")
        if (!device.hasObject(pin)) {
            device.pressMenu()
            device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4,
                device.displayWidth / 2, device.displayHeight / 4, 20)
        }
        check(device.wait(Until.hasObject(pin), remaining()) == true) {
            "Trusted SystemUI initial PIN screen did not appear"
        }
        // The public fixture PIN is the same one configured by the disposable runner.
        for (digit in "123456") {
            val key = device.wait(Until.findObject(By.res("com.android.systemui", "key$digit")), remaining())
            checkNotNull(key) { "Trusted SystemUI initial PIN key missing" }.click()
        }
        val enter = device.wait(Until.findObject(By.res("com.android.systemui", "key_enter")), remaining())
        checkNotNull(enter) { "Trusted SystemUI initial PIN confirmation missing" }.click()
        check(device.wait(Until.gone(pin), remaining()) == true) {
            "Trusted SystemUI initial PIN screen remained visible"
        }
        device.waitForIdle(remaining())
    }
    check(!keyguard.isKeyguardLocked) { "Initial system screen remains locked" }
    println("Native fixture initial keyguardLocked=false")
}
