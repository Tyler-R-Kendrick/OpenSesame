/** Prepare source-built dependencies before the unchanged per-test deadlines. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareNativeDistribution } from "../../../tools/pwa-tailscale-native-http/prepare-distribution.mjs";

export default async function setup() {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../src/lib/capabilities/tailscale-artifacts.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // The prerequisite lands before the separate native-asset activation commit.
  // Once activated, the committed native asset and both pins are mandatory.
  if (!manifest.assets.nativeHTTP) return;
  await prepareNativeDistribution(
    fileURLToPath(new URL("../../..", import.meta.url)),
    manifest.native.sourceMetadataSha256,
    manifest.native.manifestSha256,
  );
}
