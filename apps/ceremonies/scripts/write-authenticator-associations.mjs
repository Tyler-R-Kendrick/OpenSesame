import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appleAppId = process.env.OPENSESAME_IOS_APP_IDENTIFIER?.trim();
const androidPackage = process.env.OPENSESAME_ANDROID_PACKAGE_NAME?.trim();
const androidFingerprints = (
  process.env.OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!appleAppId && !androidPackage && androidFingerprints.length === 0) {
  console.warn(
    "Authenticator association inputs absent; skipping .well-known files.",
  );
  process.exit(0);
}
if (!appleAppId || !androidPackage || androidFingerprints.length === 0) {
  throw new Error(
    "Set OPENSESAME_IOS_APP_IDENTIFIER, OPENSESAME_ANDROID_PACKAGE_NAME, and OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS together.",
  );
}
if (!/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(appleAppId)) {
  throw new Error(
    "OPENSESAME_IOS_APP_IDENTIFIER must be TEAMID.bundle.identifier.",
  );
}
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(androidPackage)) {
  throw new Error(
    "OPENSESAME_ANDROID_PACKAGE_NAME is not a valid Android package name.",
  );
}
if (
  androidFingerprints.some(
    (value) => !/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i.test(value),
  )
) {
  throw new Error(
    "Android certificate fingerprints must be colon-separated SHA-256 values.",
  );
}

const directoryUrl = new URL("../dist/.well-known/", import.meta.url);
const directory = fileURLToPath(directoryUrl);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("apple-app-site-association", directoryUrl),
  `${JSON.stringify({
    applinks: {
      details: [
        {
          appIDs: [appleAppId],
          components: [
            { "/": "/invoke/*", comment: "OpenSesame authenticator requests" },
          ],
        },
      ],
    },
  })}\n`,
);
await writeFile(
  new URL("assetlinks.json", directoryUrl),
  `${JSON.stringify([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidPackage,
        sha256_cert_fingerprints: androidFingerprints,
      },
    },
  ])}\n`,
);
