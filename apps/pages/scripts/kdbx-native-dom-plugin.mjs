import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkHash =
  "d3b59272b72c8fc0dc340e2ab68940a54669bdbcc5a92e65ace9cb001d9eb169";
const adapter = fileURLToPath(
  new URL(
    "../../../packages/app-core/src/browser/kdbx-native-dom.ts",
    import.meta.url,
  ),
);

/** Only the pinned KDBX UMD's unused Node fallback; other XML users stay intact. */
export function kdbxNativeDOM(root) {
  const require = createRequire(
    resolve(root, "packages/app-core/package.json"),
  );
  const sdk = realpathSync(require.resolve("kdbxweb"));
  const verify = () => {
    const hash = createHash("sha256").update(readFileSync(sdk)).digest("hex");
    if (hash !== sdkHash)
      throw new Error(
        "KDBX native DOM adapter requires the reviewed SDK bytes.",
      );
  };
  return {
    name: "kdbx-native-dom",
    apply: "build",
    enforce: "pre",
    buildStart: verify,
    resolveId(source, importer) {
      if (source !== "@xmldom/xmldom" || importer !== sdk) return null;
      verify();
      return adapter;
    },
  };
}
