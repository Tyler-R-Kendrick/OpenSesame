import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
const root = new URL("../../", import.meta.url);
test("required Android device run includes actual canary owner and Keystore cases", () => {
  const script = readFileSync(
    fileURLToPath(new URL("apps/android/scripts/test-android-device.sh", root)),
    "utf8",
  );
  const tests = readFileSync(
    fileURLToPath(
      new URL(
        "apps/android/android/app/src/androidTest/java/dev/opensesame/authenticator/NativeCanaryDeviceTest.kt",
        root,
      ),
    ),
    "utf8",
  );
  assert.match(
    script,
    /-e class[^\n]*NativeAdmissionDeviceTest[^\n]*NativeSettingsDeviceJourneyTest[^\n]*NativeCanaryDeviceTest/,
  );
  assert.match(script, /verify-native-results\.py" android/);
  assert.match(script, /--pages "\$device_pages"/);
  assert.match(script, /device_report_dir/);
  assert.equal((tests.match(/@Test fun /g) ?? []).length, 6);
  assert.match(
    tests,
    /normalOwnerPasswordChangeRefusesHeldIssuerResultWithoutChangingRealEpoch/,
  );
  assert.match(
    tests,
    /completedOwnerDerivationCannotCommitIntoFreshSameWalletSuccessor/,
  );
  assert.match(
    tests,
    /cancelActualManagementOwnerPromptDoesNotInstallSecondaryState/,
  );
  assert.match(
    tests,
    /secondaryCiphertextTamperingFailsClosedWithoutBreakingPrimaryAdmissionRecord/,
  );
});
