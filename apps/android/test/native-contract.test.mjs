import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("native builds register the standard OID4VC invocation surfaces", async () => {
  const manifest = await read("android/app/src/main/AndroidManifest.xml");
  for (const scheme of [
    "openid4vp",
    "openid-credential-offer",
    "haip-vp",
    "haip-vci",
  ]) {
    assert.match(manifest, new RegExp(`android:scheme="${scheme}"`, "u"));
  }
  assert.match(manifest, /android:autoVerify="true"/u);
});

test("protocol dependencies and iOS binary checksum stay pinned", async () => {
  const gradle = await read("android/app/build.gradle.kts");
  const swift = await read("ios/Package.swift");
  assert.match(gradle, /org\.multipaz:multipaz:0\.100\.0/u);
  assert.match(
    swift,
    /https:\/\/apps\.multipaz\.org\/xcf\/Multipaz-0\.100\.0\.xcframework\.zip/u,
  );
  assert.match(
    swift,
    /6098070b02dfe416f27146b9ca43d7867182caf93d5f872aaf560c1af9764452/u,
  );
});

test("Apple app registers issuance while OID4VP stays in the document provider", async () => {
  const info = await read("ios/Info.plist");
  const entitlements = await read("ios/OpenSesameAuthenticator.entitlements");
  const provider = await read(
    "ios/IdentityDocumentProvider/DocumentProvider.swift",
  );
  for (const scheme of ["openid-credential-offer", "haip-vci"]) {
    assert.match(info, new RegExp(`<string>${scheme}</string>`, "u"));
  }
  for (const scheme of ["openid4vp", "haip-vp", "mdoc"]) {
    assert.doesNotMatch(info, new RegExp(`<string>${scheme}</string>`, "u"));
  }
  assert.match(entitlements, /applinks:\$\(OPENSESAME_INVOCATION_HOST\)/u);
  assert.match(provider, /IdentityDocumentRequestScene/u);
  assert.match(provider, /RequestAuthorizationView/u);
});

test("both native adapters call generated bindings from one Rust core", async () => {
  const android = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt",
  );
  const apple = await read(
    "ios/Sources/OpenSesameAuthenticator/WalletView.swift",
  );
  const kotlinBinding = await read(
    "generated/kotlin/uniffi/opensesame_authenticator_core/opensesame_authenticator_core.kt",
  );
  const swiftBinding = await read(
    "ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_core.swift",
  );
  for (const source of [android, apple, kotlinBinding, swiftBinding]) {
    assert.match(source, /validatePlatformInvocation/u);
    assert.match(source, /protocolUri/u);
  }
  await assert.rejects(
    access(
      new URL(
        "../android/app/src/main/java/dev/opensesame/authenticator/InvocationUri.kt",
        import.meta.url,
      ),
    ),
  );
});

test("issuance refuses redirects and requires a remote HTTPS attestation service", async () => {
  const runtime = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/WalletRuntime.kt",
  );
  assert.match(runtime, /followRedirects = false/u);
  assert.match(runtime, /WALLET_BACKEND_URL\.startsWith\("https:\/\/"\)/u);
  assert.doesNotMatch(runtime, /OpenID4VCILocalBackend/u);
});

test("app links and OID4VC schemes follow spec/config/ceremony-routes.json", async () => {
  const manifest = await read("android/app/src/main/AndroidManifest.xml");
  const { routes } = JSON.parse(
    await read("../../spec/config/ceremony-routes.json"),
  );
  const prefixOf = (path) => {
    const open = path.indexOf("{");
    return open === -1 ? path : path.slice(0, open);
  };
  const prefixes = Object.values(routes).map(({ path }) => prefixOf(path));
  const registered = [
    ...manifest.matchAll(/android:pathPrefix="([^"]*)"/gu),
  ].map(([, prefix]) => prefix);
  assert.ok(registered.length > 0, "the manifest registers an app link");
  for (const prefix of registered) {
    assert.ok(prefixes.includes(prefix), `${prefix} is not a ceremony route`);
  }
  const invoke = prefixOf(routes.invoke.path);
  assert.ok(registered.includes(invoke), `${invoke} is not an app link`);
  for (const kind of ["oid4vp", "oid4vci"]) {
    const scheme = routes.invoke.kinds[kind].app.split(":")[0];
    assert.match(manifest, new RegExp(`android:scheme="${scheme}"`, "u"));
  }
});

test("native traps are actual shared-core calls with protected local persistence", async () => {
  const android = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/NativeGate.kt",
  );
  const apple = await read(
    "ios/Sources/OpenSesameAuthenticator/WalletAdmission.swift",
  );
  const kotlinBinding = await read(
    "generated/kotlin/uniffi/opensesame_authenticator_core/opensesame_authenticator_core.kt",
  );
  const swiftBinding = await read(
    "ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_core.swift",
  );
  for (const source of [android, apple, kotlinBinding, swiftBinding]) {
    for (const method of [
      "nativeGateAdmit",
      "nativeGateCreate",
      "nativeGateStatus",
    ]) {
      assert.ok(source.includes(method), `native integration calls ${method}`);
    }
  }
  const androidStorage = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/NativeCanaryStorage.kt",
  );
  assert.match(androidStorage, /AndroidKeyStore/u);
  assert.match(androidStorage, /AES\/GCM\/NoPadding/u);
  assert.match(androidStorage, /cipher\.updateAAD\(account/u);
  assert.match(androidStorage, /"opensesame\.native-observations\.v1"/u);
  assert.match(android, /NativeCanaryStorage\.readGate/u);
  assert.match(android, /NativeCanaryStorage\.saveGate/u);
  assert.match(android, /NativeCanaryStorage\.commit/u);
  assert.match(android, /BIOMETRIC_STRONG or DEVICE_CREDENTIAL/u);
  const storage = await read(
    "ios/Sources/OpenSesameAuthenticator/NativeGateStorage.swift",
  );
  assert.match(storage, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/u);
  assert.match(storage, /deviceOwnerAuthentication/u);
});

test("provider startup and production handback require real native admission", async () => {
  for (const name of ["OpenId4VpActivity", "DigitalCredentialsActivity"]) {
    const source = await read(
      `android/app/src/main/java/dev/opensesame/authenticator/${name}.kt`,
    );
    assert.ok(
      source.indexOf("NativeGate.requireReal()") <
        source.indexOf("WalletRuntime.initialize()"),
    );
    assert.match(source, /NativeGate\.ownerProof\(this\)/u);
    assert.match(source, /NativeGate\.requireSame\(permit\)/u);
  }
  const engine = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/RealmHttpEngine.kt",
  );
  assert.match(engine, /object : HttpClientEngineBase\("realm-guard"\)/u);
  assert.doesNotMatch(engine, /HttpClientEngine by delegate/u);
  assert.match(engine, /NativeGate\.onInvalidated\(permit, it\)/u);
  assert.ok(
    engine.indexOf("requireCurrent()") <
      engine.indexOf("delegate.execute(data)"),
  );
  assert.ok(
    engine.lastIndexOf("requireCurrent()") >
      engine.indexOf("delegate.execute(data)"),
  );
  assert.match(engine, /coroutineContext\.cancel\(\)/u);
  assert.match(engine, /delegate\.close\(\)/u);
  const provider = await read(
    "ios/IdentityDocumentProvider/DocumentProvider.swift",
  );
  assert.ok(
    provider.indexOf("NativeGateStorage.ownerProof()") <
      provider.indexOf("IosStorage("),
  );
  assert.ok(
    provider.indexOf("consumePresentationGrant()") <
      provider.indexOf("IosStorage("),
  );
  assert.match(provider, /requirePresentation\(permit\)/u);
  assert.match(provider, /NativeGatedStorage/u);
  assert.match(provider, /NativeGatedSecureArea/u);
  assert.match(provider, /NativeGatedPresentmentSource/u);
  const wallet = await read(
    "ios/Sources/OpenSesameAuthenticator/WalletModel.swift",
  );
  assert.match(wallet, /admission\.authorityFence\(permit\)/u);
  assert.match(
    wallet,
    /httpClientEngine: NativeRealmHttpEngine\(fence: fence\)/u,
  );
  assert.match(wallet, /authority\?\.revoke\(\)/u);
  assert.doesNotMatch(wallet, /Darwin\(\)/u);
  const appleEngine = await read(
    "ios/Sources/OpenSesameAuthenticator/NativeRealmHttpEngine.swift",
  );
  assert.match(appleEngine, /: HttpClientEngineBase/u);
  assert.match(appleEngine, /fence\.perform/u);
  assert.match(appleEngine, /fence\.addCancellation/u);
  assert.match(appleEngine, /coroutineContext\.cancel_\(cause: nil\)/u);
  const action = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt",
  );
  assert.match(
    action,
    /invokeNativeExternalAction\(renderedOwner, NativeGate::requireSame\)/u,
  );
  assert.match(action, /NativeGate\.requireSame\(owner\)/u);
});

test("synthetic presentation is fixed data outside the production wallet model", async () => {
  const android = await read(
    "android/app/src/main/java/dev/opensesame/authenticator/NativeGateView.kt",
  );
  const start = android.indexOf("fun SyntheticWalletView");
  const end = android.indexOf("fun NativeSecurityView", start);
  const synthetic = android.slice(start, end);
  assert.match(synthetic, /member@example\.invalid/u);
  assert.doesNotMatch(
    synthetic,
    /WalletRuntime|provisioningModel|presentmentSource/u,
  );
  const apple = await read(
    "ios/Sources/OpenSesameAuthenticator/WalletView.swift",
  );
  const a = apple.indexOf("case .synthetic:");
  const b = apple.indexOf("case .real:", a);
  assert.match(apple.slice(a, b), /member@example\.invalid/u);
  assert.doesNotMatch(apple.slice(a, b), /ProvisioningView|model\./u);
});

test("Apple gates require fourteen framework cases and both real owner UI journeys", async () => {
  const runner = await read("scripts/test-apple.sh");
  const ui = await read("ios/UITests/NativeOwnerJourneyUITests.swift");
  const project = await read("ios/project.yml");
  const fixture = await read("scripts/apple-biometric-fixture.py");
  const cases = await read("scripts/verify-apple-results.py");
  const bridge = await read(
    "ios/Tests/OpenSesameAuthenticatorTests/NativeAuthorityBridgeTests.swift",
  );
  assert.match(
    cases,
    /realMultipazStorageSigningAndSelectionRejectStaleAdmission/u,
  );
  assert.match(bridge, /SoftwareSecureArea\.companion\.create/u);
  assert.match(bridge, /Crypto\.shared\.checkSignature/u);
  assert.match(bridge, /selectedSource\.selectCredential/u);
  for (const name of [
    "testColdLaunchAndUnavailableOwnerAuthenticationNeverExposeProductionUi",
    "testVisibleOwnerRetiredPasswordLifecycle",
    "testVisibleFreshOwnerControlledCanaryLifecycle",
  ]) {
    assert.ok(runner.includes(name));
  }
  assert.match(runner, /run_apple_phase cold/u);
  assert.match(runner, /run_apple_phase password/u);
  assert.match(runner, /run_apple_phase canary/u);
  assert.match(runner, /verify-apple-results\.py/u);
  assert.match(fixture, /com\.apple\.BiometricKit_Sim\.pearl\.match/u);
  assert.match(fixture, /"simctl", "spawn", device, "notifyutil"/u);
  assert.doesNotMatch(
    ui,
    /nativeGateCreate|replaceRecord|presentation-grant|nativeCanaryManage/u,
  );
  assert.match(
    project,
    /OpenSesameBiometricHelperURL: \$\(OPENSESAME_TEST_BIOMETRIC_HELPER_URL\)/u,
  );
});

test("Apple result and OS sensor adapter fixtures reject missing or invalid proof", async () => {
  for (const name of ["apple-results-test.py", "apple-sensor-test.py"]) {
    await promisify(execFile)(
      "python3",
      [fileURLToPath(new URL(name, import.meta.url))],
      {
        timeout: 30_000,
      },
    );
  }
});

test("native report collection requires every current JVM and device case", async () => {
  const windows = await read("scripts/test-windows.ps1");
  const android = await read("scripts/test-native.sh");
  const device = await read("scripts/test-android-device.sh");
  const catalog = JSON.parse(await read("scripts/native-required-cases.json"));
  assert.match(windows, /verify-native-results\.py/u);
  assert.match(windows, /Invoke-NativeTests "windows-library"/u);
  assert.match(windows, /Invoke-NativeTests "windows-retired-refusal"/u);
  assert.match(windows, /windows-cli-build\.json/u);
  assert.match(android, /verify-native-results\.py" jvm/u);
  assert.match(device, /verify-native-results\.py" android/u);
  for (const [folder, groups, total] of [
    ["test", catalog.jvm, 26],
    ["androidTest", catalog.androidDevice, 12],
  ]) {
    const declared = [];
    const required = [];
    for (const [suite, methods] of Object.entries(groups)) {
      const name = suite.split(".").at(-1);
      const source = await read(
        `android/app/src/${folder}/java/dev/opensesame/authenticator/${name}.kt`,
      );
      for (const method of source.matchAll(/@Test\s+fun\s+(\w+)\s*\(/gu)) {
        declared.push(`${suite}.${method[1]}`);
      }
      for (const method of methods) required.push(`${suite}.${method}`);
    }
    assert.equal(required.length, total);
    assert.equal(new Set(required).size, total);
    assert.deepEqual(required.sort(), declared.sort());
  }
});

test("exact native result parser rejects missing, duplicate, skipped and failing cases", async () => {
  await promisify(execFile)(
    "python3",
    [fileURLToPath(new URL("native-results-test.py", import.meta.url))],
    { timeout: 30_000 },
  );
});
