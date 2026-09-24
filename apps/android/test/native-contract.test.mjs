import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(swift, /Multipaz-0\.100\.0\.xcframework\.zip/u);
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
  assert.match(entitlements, /applinks:auth\.opensesame\.dev/u);
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
