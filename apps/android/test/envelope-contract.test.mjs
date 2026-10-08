import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("envelope storage retains native admission and actual Apple provider compilation", async () => {
  const runtime = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/WalletRuntime.kt",
  );
  assert.match(runtime, /WalletEnvelopeStorage\(/u);
  assert.match(
    runtime,
    /NativeGatedStorage\(Platform\.nonBackedUpStorage, authority\)/u,
  );
  assert.match(runtime, /createNativeSecureArea\(storage, authority\)/u);
  assert.ok(
    runtime.indexOf(
      "NativeGate.requireReal()",
      runtime.indexOf("suspend fun initialize"),
    ) < runtime.indexOf("Platform.nonBackedUpStorage"),
  );
  assert.match(runtime, /NativeGate\.requireSame\(permit\)/u);
  const sdkArea = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/NativeGatedSecureArea.kt",
  );
  assert.match(
    sdkArea,
    /NativeGatedSecureArea\(AndroidKeystoreSecureArea\.create\(storage\), authority\)/u,
  );
  assert.doesNotMatch(runtime, /Platform\.getSecureArea\(storage\)/u);
  const appleArea = await read(
    "ios/Sources/OpenSesameAuthenticator/NativeGatedSecureArea.swift",
  );
  assert.match(
    appleArea,
    /SecureEnclaveSecureArea\.companion\.create\(storage: storage, partitionId: "default"\)/u,
  );

  const project = await read("ios/project.yml");
  assert.equal(
    [...project.matchAll(/OpenSesameWalletKeychainGroup:/gu)].length,
    2,
  );
  for (const product of ["WalletEnvelopeStorage", "WalletEnvelopeCore"]) {
    assert.match(project, new RegExp(`product: ${product}`, "u"));
  }
  for (const helper of [
    "NativeGateStorage",
    "NativeAuthorityFence",
    "NativeGatedStorage",
    "NativeGatedSecureArea",
    "NativeGatedPresentmentSource",
  ]) {
    assert.ok(
      project.includes(`Sources/OpenSesameAuthenticator/${helper}.swift`),
    );
  }
  assert.match(
    project,
    /OpenSesameDocumentProvider:[\s\S]*type: extensionkit-extension/u,
  );
  const runner = await read("scripts/test-apple.sh");
  assert.match(runner, /-only-testing:NativeEnvelopeStorageTests/u);
  assert.match(runner, /-only-testing:NativeEnvelopeCoreTests/u);
});

test("Apple envelope construction stays within the original admission fence", async () => {
  for (const path of [
    "ios/IdentityDocumentProvider/DocumentProvider.swift",
    "ios/Sources/OpenSesameAuthenticator/WalletModel.swift",
  ]) {
    const source = await read(path);
    assert.match(source, /fence\.withCurrent/u);
    assert.match(source, /WalletStorageFactory\.open/u);
    assert.match(source, /NativeGatedStorage/u);
    assert.match(source, /createNativeSecureArea/u);
    assert.match(
      source,
      /decorateRaw: \{ NativeGatedStorage\(delegate: \$0, fence: fence\) \}/u,
    );
    assert.doesNotMatch(source, /Platform\.shared\.getSecureArea/u);
    assert.doesNotMatch(source, /IosStorage\(/u);
  }
});

test("device fixtures require the actual trusted OS PIN editor and main-thread provider refusal", async () => {
  for (const name of [
    "NativeAdmissionDeviceTest",
    "NativeCanaryDeviceTest",
    "NativeSettingsDeviceJourneyTest",
  ]) {
    const source = await read(
      `android/app/src/androidTest/java/dev/opensesame/authenticator/${name}.kt`,
    );
    assert.match(
      source,
      /By\.res\("com\.android\.systemui", "lockPassword"\)\.pkg\("com\.android\.systemui"\)/u,
    );
    assert.match(
      source,
      /Until\.hasObject\(ownerCredentialField\(\)\), 30_000/u,
    );
    assert.match(
      source,
      /findObject\(ownerCredentialField\(\)\)\)\.click\(\)/u,
    );
    assert.match(source, /input text 123456/u);
    assert.doesNotMatch(source, /By\.text\("Verify OpenSesame owner"\)/u);
    assert.match(source, /resourceName \?: it\.className/u);
  }
  const admission = await read(
    "android/app/src/androidTest/java/dev/opensesame/authenticator/NativeAdmissionDeviceTest.kt",
  );
  assert.match(admission, /denyProviders\(\) = app\.runOnUiThread/u);
  assert.match(
    admission,
    /NativeGate\.session is NativeSession\.Real && !device\.hasObject/u,
  );
});
