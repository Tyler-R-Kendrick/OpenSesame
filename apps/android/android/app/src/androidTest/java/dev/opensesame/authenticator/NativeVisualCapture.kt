package dev.opensesame.authenticator

import android.content.Context
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Captures the actual asserted UI. No text, field values, owner grants or receiver material is recorded. */
internal object NativeVisualCapture {
    private val names = setOf("security-empty", "enrollment-default", "reject-enrolled", "synthetic-enrolled",
        "reject-result", "synthetic-realm", "fresh-owner", "revoked", "revoked-rejected")

    fun capture(context: Context, checkpoint: String, target: SemanticsNodeInteraction) {
        check(checkpoint in names)
        val arguments = InstrumentationRegistry.getArguments()
        val source = checkNotNull(arguments.getString("visualSourceSha"))
        check(source.matches(Regex("[0-9a-f]{40}")))
        val run = checkNotNull(arguments.getString("visualRunId"))
        check(run.matches(Regex("[a-z0-9-]{1,96}")))
        val directory = File(context.filesDir, "native-visual/$run")
        check(directory.isDirectory || directory.mkdirs())
        val image = File(directory, "$checkpoint.png")
        val metadata = File(directory, "$checkpoint.json")
        check(!image.exists() && !metadata.exists())
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        check(device.takeScreenshot(image))
        val rect = target.fetchSemanticsNode().boundsInWindow
        val bounds = JSONObject().put("name", "asserted-state").put("x", rect.left)
            .put("y", rect.top).put("width", rect.width).put("height", rect.height)
        val record = JSONObject().put("v", 1).put("platform", "android").put("checkpoint", checkpoint)
            .put("sourceSha", source).put("applicationSha256", sha256(File(context.applicationInfo.sourceDir)))
            .put("imageSha256", sha256(image)).put("pages", checkNotNull(arguments.getString("visualPages")).toInt())
            .put("viewport", JSONObject().put("width", device.displayWidth).put("height", device.displayHeight))
            .put("density", context.resources.displayMetrics.density).put("bounds", JSONArray().put(bounds))
        metadata.writeText(record.toString())
    }

    private fun sha256(file: File): String {
        check(file.length() in 1..268_435_456)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
