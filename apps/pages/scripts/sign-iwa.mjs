import { spawnSync } from "node:child_process";
/**
 * Bundle and sign the IWA. `wbn` and `wbn-sign` are pinned dev dependencies;
 * the signing key and passphrase never enter this repository.
 *
 *   IWA_SIGNING_KEY=/secure/private_key.pem \
 *   WEB_BUNDLE_SIGNING_PASSPHRASE=… pnpm run build:iwa:signed
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, process.env.IWA_OUT_DIR ?? "dist-iwa");
const key = process.env.IWA_SIGNING_KEY;
if (!key) throw new Error("IWA_SIGNING_KEY must name a PEM private key");
if (!existsSync(key)) throw new Error(`IWA_SIGNING_KEY does not exist: ${key}`);

const wbn = join(root, "node_modules/wbn/bin/wbn.js");
const wbnSign = join(root, "node_modules/wbn-sign/bin/wbn-sign.js");
const bundle = join(out, "opensesame.wbn");
const signed = join(out, "opensesame.swbn");
for (const [script, args] of [
  [wbn, ["--dir", out, "-o", bundle]],
  [wbnSign, ["sign", bundle, key, "-o", signed]],
]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`signed IWA: ${signed}`);
