import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const checkpoints = [
  "security-empty",
  "enrollment-default",
  "reject-enrolled",
  "synthetic-enrolled",
  "reject-result",
  "synthetic-realm",
  "fresh-owner",
  "revoked",
  "revoked-rejected",
];

test("positive native captures use real screenshots after existing visible journeys", async () => {
  const android = await read(
    "android/app/src/androidTest/java/dev/opensesame/authenticator/NativeSettingsDeviceJourneyTest.kt",
  );
  const apple = await read("ios/UITests/NativeOwnerJourneyUITests.swift");
  for (const name of checkpoints) {
    for (const source of [android, apple]) {
      assert.equal(source.split(`capture("${name}"`).length - 1, 1);
    }
  }
  const capture = await read(
    "android/app/src/androidTest/java/dev/opensesame/authenticator/NativeVisualCapture.kt",
  );
  assert.match(capture, /check\(device\.takeScreenshot\(image\)\)/u);
  assert.match(capture, /boundsInWindow/u);
  assert.match(
    capture,
    /sha256\(File\(context\.applicationInfo\.sourceDir\)\)/u,
  );
  const swift = await read("ios/UITests/NativeVisualCapture.swift");
  assert.match(swift, /app\.screenshot\(\)/u);
  assert.match(swift, /attachment\.lifetime = \.keepAlways/u);
  assert.match(swift, /target\.frame/u);
  assert.doesNotMatch(swift, /typeText|replaceRecord|nativeGateCreate/u);
});

test("native capture admission binds exact source and retains failed attempts", async () => {
  const android = await read("scripts/test-android-device.sh");
  const apple = await read("scripts/test-apple.sh");
  for (const source of [android, apple]) {
    assert.match(source, /GITHUB_SHA/u);
    assert.match(source, /verify-native-visual\.py/u);
  }
  assert.match(android, /trap 'finish_device_attempt "\$\?"' EXIT/u);
  assert.ok(
    android.indexOf("verify-native-results.py") <
      android.indexOf("verify-native-visual.py"),
  );
  assert.match(apple, /test \|\| test_status=\$\?/u);
  assert.match(
    apple,
    /collect_apple_visual "\$phase" "\$result" \|\| capture_status/u,
  );
  assert.match(apple, /xcresulttool export attachments --help/u);
  assert.match(apple, /xcresulttool export attachments --path/u);
  assert.match(apple, /shasum -a 256 "\$executable"/u);
  const project = await read("ios/project.yml");
  assert.match(
    project,
    /OpenSesameVisualSourceSHA: \$\(OPENSESAME_TEST_VISUAL_SOURCE_SHA\)/u,
  );
});

test("bounded native visual metadata fixtures reject incomplete or misleading proof", async () => {
  const { stderr } = await promisify(execFile)("python3", [
    "-B",
    fileURLToPath(new URL("./visual-results-test.py", import.meta.url)),
  ]);
  assert.match(stderr, /Ran 13 tests/u);
  assert.match(stderr, /\bOK\b/u);
});
