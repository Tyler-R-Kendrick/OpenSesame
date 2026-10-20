/** Pin-closed browser substitution: official XMLDSIG/C14N plus one shared X.509 parser. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pins = {
  packageSHA256:
    "1d274f8a78d3cf667040449d0d97570fc45f8dfb0dedf576cd0a96235000bbe5",
  esmSHA256: "cdd37d050f29add85b66a0d0f85b74197973c2e7ea984f213887562aad49da64",
  applicationSHA256:
    "da95873203ac9cb977dc9202e44c6910a7bbcf919e5cbd3cef51b3a701795be0",
  certificateSHA256:
    "88d8982df0ea584359915df6b2233e49f52e1345555a477eb69a9453322da899",
  callers: {
    "xml-signature.ts":
      "3c86a7cad9651b8236bae7650e4afac65650d7dfaa35fcbd47269e00549d499d",
    "metadata.ts":
      "cf769479e584bde73d764d53d3cd9e85baeaa0c49eb54d9af0966b22f079ce49",
    "authn-signature.ts":
      "93697352444301d5ea45422fbf6fa87ba7987e875083f8aa593ad47d0a89674d",
    "xml-policy.ts":
      "745558c6a3677342c746243c4ae2c60189938759f60e3a9f4729467186da6d3e",
  },
  esmFiles: 46,
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const implementationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const saml = "packages/app-core/src/browser/saml";
function match(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`SAML browser crypto pin mismatch: ${label}`);
}
function inventory(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? inventory(path, base)
        : entry.name.endsWith(".js")
          ? [
              {
                path: relative(base, path).replaceAll("\\", "/"),
                sha256: sha(readFileSync(path)),
              },
            ]
          : [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Dependency resolution belongs to app-core, never an arbitrary peer package. */
export function readSamlBrowserCryptoInputs(root) {
  const owner = createRequire(resolve(root, "packages/app-core/package.json"));
  const metadata = realpathSync(owner.resolve("xmldsigjs/package.json"));
  const packageSource = readFileSync(metadata, "utf8");
  match(sha(packageSource), pins.packageSHA256, "package");
  const parsed = JSON.parse(packageSource);
  match(parsed.name, "xmldsigjs", "package name");
  match(parsed.version, "2.8.8", "version");
  const esm = resolve(dirname(metadata), "build/esm");
  match(
    sha(JSON.stringify(inventory(esm))),
    pins.esmSHA256,
    "complete SDK call surface",
  );
  const callers = Object.entries(pins.callers).map(([name, hash]) => {
    const path = resolve(root, saml, name);
    match(sha(readFileSync(path)), hash, name);
    return path;
  });
  const x509Path = realpathSync(owner.resolve("@peculiar/x509"));
  const x509Root = resolve(dirname(x509Path), "..");
  match(
    sha(readFileSync(resolve(x509Root, "package.json"))),
    "27719c7f479804be63667f9157eed53f3b5ccb44e070067dfcc084ef06996866",
    "shared certificate package",
  );
  const sharedCertificate = resolve(x509Root, "build/x509.es.js");
  match(
    sha(readFileSync(sharedCertificate)),
    "f2cc5db5de63f76b35d9c63cc49fbed40731691313da4ec196dfd06516b8821f",
    "shared certificate implementation",
  );
  const reflectionOwner = createRequire(sharedCertificate);
  const reflection = {
    full: realpathSync(reflectionOwner.resolve("reflect-metadata")),
    lite: realpathSync(reflectionOwner.resolve("reflect-metadata/lite")),
  };
  const reflectionPackage = readFileSync(
    resolve(dirname(reflection.full), "package.json"),
  );
  match(
    sha(reflectionPackage),
    "e0f6d5cf809e02e338f501d3030e917fa57e3a10044387de890cbf142b4f4083",
    "reflection package",
  );
  match(
    sha(readFileSync(reflection.full)),
    "515c16dcde7492755691e3fca9eeca4656f1819b6e3307ecd4b0deaa93ad21e2",
    "reflection default implementation",
  );
  match(
    sha(readFileSync(reflection.lite)),
    "92d7537f2c9416514356dc386763a0284cf856a1771c2570bfd9d4e7eced3826",
    "reflection lite implementation",
  );
  const reflectionExports = JSON.parse(reflectionPackage);
  match(reflectionExports.version, "0.2.2", "reflection version");
  match(
    reflectionExports.exports["./lite"].default,
    "./ReflectLite.js",
    "official lite export",
  );
  const application = resolve(esm, "application.js");
  const certificate = resolve(esm, "pki/x509.js");
  const replacements = new Map([
    [
      application,
      resolve(implementationRoot, saml, "xml-crypto-application.ts"),
    ],
    [
      certificate,
      resolve(implementationRoot, saml, "xml-crypto-certificate.ts"),
    ],
  ]);
  return {
    esm,
    sharedCertificate,
    reflection,
    callers: callers.slice(0, 3),
    replacements,
    application,
    certificate,
  };
}

function assertAdapterConsumers(context, input) {
  for (const [sdkPath, adapter] of input.replacements) {
    const adapterInfo = context.getModuleInfo(adapter);
    const allowed =
      sdkPath === input.application
        ? [sdkPath, input.replacements.get(input.certificate)]
        : [sdkPath];
    if (
      !adapterInfo ||
      [...adapterInfo.importers, ...adapterInfo.dynamicImporters].some(
        (id) => !allowed.includes(id),
      )
    )
      throw new Error("Unexpected browser XMLDSIG adapter consumer");
  }
}

function assertSdkConsumers(context, input, entry, ids) {
  for (const id of ids) {
    const clean = id.replaceAll("\\", "/");
    if (
      clean.includes("/node_modules/xmldsigjs/") &&
      !id.startsWith(`${input.esm}/`)
    )
      throw new Error("Unexpected browser XMLDSIG package instance");
    if (id.startsWith(`${input.esm}/`) && id !== entry) {
      const module = context.getModuleInfo(id);
      const consumers = [...module.importers, ...module.dynamicImporters];
      if (consumers.some((consumer) => !consumer.startsWith(`${input.esm}/`)))
        throw new Error("Unexpected browser XMLDSIG consumer");
    }
  }
}

/** No global package aliases: only the exact pinned SDK modules change their implementation. */
export function samlBrowserCrypto(root) {
  let input;
  const transformed = new Set();
  return {
    name: "saml-shared-browser-crypto",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readSamlBrowserCryptoInputs(root);
      transformed.clear();
    },
    async resolveId(source, importer) {
      if (source !== "reflect-metadata") return null;
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const original = await this.resolve(source, importer, { skipSelf: true });
      return original?.id === input.reflection.full
        ? input.reflection.lite
        : null;
    },
    transform(source, id) {
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const replacement = input.replacements.get(id);
      if (!replacement) return null;
      match(
        sha(source),
        id === input.application
          ? pins.applicationSHA256
          : pins.certificateSHA256,
        "transform source",
      );
      transformed.add(id);
      return {
        code: `export * from ${JSON.stringify(replacement)};`,
        map: null,
      };
    },
    generateBundle() {
      if (!input) throw new Error("SAML browser crypto was not initialized");
      const entry = resolve(input.esm, "index.js");
      const info = this.getModuleInfo(entry);
      if (!info) {
        match(transformed.size, 0, "unowned transformation");
        return;
      }
      const importers = [...info.importers, ...info.dynamicImporters];
      if (
        !importers.length ||
        importers.some((id) => !input.callers.includes(id))
      )
        throw new Error("Unexpected browser XMLDSIG consumer");
      match(transformed.size, 2, "both SDK wrappers");
      assertAdapterConsumers(this, input);
      const ids = [...this.getModuleIds()];
      assertSdkConsumers(this, input, entry, ids);
      if (!ids.includes(input.sharedCertificate))
        throw new Error(
          "SAML browser lost the shared official certificate parser",
        );
      if (
        ids.some((id) =>
          /\/node_modules\/(?:pkijs|bytestreamjs)\//.test(
            id.replaceAll("\\", "/"),
          ),
        )
      )
        throw new Error("SAML browser retained a second certificate engine");
      for (const name of ["signed_xml.js", "canonicalizer.js"])
        if (!ids.includes(resolve(input.esm, name)))
          throw new Error("SAML browser lost the official XML verifier");
    },
  };
}
