#!/usr/bin/env node
/**
 * Write `dist/.well-known/apple-app-site-association` and
 * `dist/.well-known/assetlinks.json`: the associations that let the native
 * authenticator open an `/invoke/<kind>` link itself (ADR 0140 D11).
 *
 * Run by the Vercel build only (`vercel.json` `buildCommand`), which serves
 * this app at the host root. GitHub Pages serves it under `/OpenSesame/` and
 * cannot serve host-root `.well-known` files, so `deploy-pages.yml` never
 * runs this.
 *
 * All three variables, or none: with none set the build writes nothing and
 * the page still hands off by its own key. A partial set, or a value of the
 * wrong shape, fails the build rather than publishing an association that
 * names the wrong app.
 *
 * The paths an association claims are the app-link routes
 * `spec/config/ceremony-routes.json` lists (ADR 0139), not a list here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC = new URL(
  "../../../spec/config/ceremony-routes.json",
  import.meta.url,
);

const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i;

/**
 * The association inputs from `environment`, validated; `null` when none of
 * the three is set. Throws on a partial set or a malformed value.
 */
export function associationInputs(environment) {
  const appleAppId = environment.OPENSESAME_IOS_APP_IDENTIFIER?.trim();
  const androidPackage = environment.OPENSESAME_ANDROID_PACKAGE_NAME?.trim();
  const androidFingerprints = (
    environment.OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!appleAppId && !androidPackage && androidFingerprints.length === 0) {
    return null;
  }
  if (!appleAppId || !androidPackage || androidFingerprints.length === 0) {
    throw new Error(
      "Set OPENSESAME_IOS_APP_IDENTIFIER, OPENSESAME_ANDROID_PACKAGE_NAME, and OPENSESAME_ANDROID_SHA256_CERT_FINGERPRINTS together.",
    );
  }
  if (!APPLE_APP_ID.test(appleAppId)) {
    throw new Error(
      "OPENSESAME_IOS_APP_IDENTIFIER must be TEAMID.bundle.identifier.",
    );
  }
  if (!ANDROID_PACKAGE.test(androidPackage)) {
    throw new Error(
      "OPENSESAME_ANDROID_PACKAGE_NAME is not a valid Android package name.",
    );
  }
  if (androidFingerprints.some((value) => !SHA256_FINGERPRINT.test(value))) {
    throw new Error(
      "Android certificate fingerprints must be colon-separated SHA-256 values.",
    );
  }
  return { appleAppId, androidPackage, androidFingerprints };
}

/**
 * The host-root path patterns an app may claim: every route whose kinds
 * name a native `app` link, as its fixed prefix plus `*`
 * (`/invoke/{kind}` → `/invoke/*`).
 */
export function appLinkPaths(spec) {
  return Object.values(spec.routes)
    .filter((route) =>
      Object.values(route.kinds ?? {}).some((kind) => Boolean(kind.app)),
    )
    .map((route) => {
      const open = route.path.indexOf("{");
      const prefix = open === -1 ? route.path : route.path.slice(0, open);
      return `${prefix.endsWith("/") ? prefix : `${prefix}/`}*`;
    });
}

/** The two association documents, as the bytes written. */
export function associationFiles(inputs, paths) {
  const apple = {
    applinks: {
      details: [
        {
          appIDs: [inputs.appleAppId],
          components: paths.map((path) => ({
            "/": path,
            comment: "OpenSesame authenticator requests",
          })),
        },
      ],
    },
  };
  const android = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: inputs.androidPackage,
        sha256_cert_fingerprints: inputs.androidFingerprints,
      },
    },
  ];
  return {
    "apple-app-site-association": `${JSON.stringify(apple)}\n`,
    "assetlinks.json": `${JSON.stringify(android)}\n`,
  };
}

/**
 * Write the associations into `<dist>/.well-known/`. Returns the names
 * written, or `[]` when no inputs are set.
 */
export async function writeAssociations(dist, environment) {
  const inputs = associationInputs(environment);
  if (inputs === null) return [];
  const spec = JSON.parse(await readFile(SPEC, "utf8"));
  const files = associationFiles(inputs, appLinkPaths(spec));
  const directory = resolve(dist, ".well-known");
  await mkdir(directory, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(resolve(directory, name), body);
  }
  return Object.keys(files);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  const written = await writeAssociations(dist, process.env);
  console.log(
    written.length === 0
      ? "Authenticator association inputs absent; skipping .well-known files."
      : `.well-known: ${written.join(", ")}`,
  );
}
