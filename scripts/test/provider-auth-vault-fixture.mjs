/** Official Vault test service, verified against upstream release SHA256SUMS. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = "1.21.4";
const PINS = {
  x64: {
    platform: "amd64",
    sha256: "889b681990fe221b884b7932fa9c9dd0ee9811b9349554f1aa287ab63c9f3dae",
  },
  arm64: {
    platform: "arm64",
    sha256: "1104ef701aad16e104e2e7b4d2a02a6ec993237559343f3097ac63a00b42e85d",
  },
};

function downloadVaultFixture(archive, pin) {
  const temporary = `${archive}.part`;
  try {
    execFileSync("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--retry-delay",
      "1",
      "--max-time",
      "180",
      "--output",
      temporary,
      `https://releases.hashicorp.com/vault/${VERSION}/vault_${VERSION}_linux_${pin.platform}.zip`,
    ]);
    const digest = createHash("sha256")
      .update(fs.readFileSync(temporary))
      .digest("hex");
    assert.equal(
      digest,
      pin.sha256,
      "Downloaded Vault release must match the upstream checksum",
    );
    fs.renameSync(temporary, archive);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function providerAuthVaultFixture(out) {
  assert.equal(
    process.platform,
    "linux",
    "The provider fixture currently requires Linux",
  );
  const pin = PINS[process.arch];
  assert.ok(
    pin,
    "The provider fixture requires a checksum-pinned CPU architecture",
  );
  const directory = path.join(out, `vault-${VERSION}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = path.join(
    directory,
    `vault_${VERSION}_linux_${pin.platform}.zip`,
  );
  if (!fs.existsSync(archive)) downloadVaultFixture(archive, pin);
  const digest = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  assert.equal(
    digest,
    pin.sha256,
    "Official Vault release archive checksum must match",
  );
  execFileSync("unzip", ["-o", "-j", archive, "vault", "-d", directory], {
    stdio: "ignore",
  });
  const binary = path.join(directory, "vault");
  fs.chmodSync(binary, 0o700);
  assert.match(
    execFileSync(binary, ["version"], { encoding: "utf8" }),
    /Vault v1\.21\.4/,
  );
  return binary;
}
