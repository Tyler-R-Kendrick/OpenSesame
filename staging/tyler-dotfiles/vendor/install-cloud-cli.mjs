#!/usr/bin/env node
// Vendored from OpenSesame scripts/dev/install-cloud-cli.mjs.
// The manifest path is ./downloads.json so this tree stands alone.
// Install only the versioned, integrity-locked cloud CLI artifacts we reviewed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const manifest = JSON.parse(
  readFileSync(new URL("./downloads.json", import.meta.url), "utf8"),
);
const [tool, destination] = process.argv.slice(2);
if (
  !["grok", "cursor"].includes(tool) ||
  !destination ||
  process.argv.length !== 4
)
  throw new Error("Usage: install-cloud-cli.mjs <grok|cursor> <destination>");
const release = manifest[tool];
const artifact = release.artifacts[`${process.platform}-${process.arch}`];
if (!artifact)
  throw new Error(
    `Unsupported ${tool} platform: ${process.platform}-${process.arch}`,
  );
if (
  !/^https:\/\//.test(artifact.url) ||
  !/^[a-f0-9]{64}$/.test(artifact.sha256)
)
  throw new Error("Invalid pinned artifact metadata");

const scratch = mkdtempSync(join(tmpdir(), "opensesame-cloud-cli-"));
try {
  const download = join(scratch, "download");
  execFileSync("curl", [
    "--proto",
    "=https",
    "--tlsv1.2",
    "-fsSL",
    artifact.url,
    "-o",
    download,
  ]);
  const actual = createHash("sha256")
    .update(readFileSync(download))
    .digest("hex");
  if (actual !== artifact.sha256)
    throw new Error(`Integrity mismatch for ${tool} ${release.version}`);

  const target = resolve(destination);
  if (tool === "grok") {
    mkdirSync(dirname(target), { recursive: true });
    const staging = mkdtempSync(join(dirname(target), ".grok-"));
    try {
      const staged = join(staging, "grok");
      copyFileSync(download, staged);
      chmodSync(staged, 0o755);
      renameSync(staged, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    console.log(target);
  } else {
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    // Nothing from the archive is extracted until the whole payload is verified.
    execFileSync("tar", [
      "--strip-components=1",
      "-xzf",
      download,
      "-C",
      extracted,
    ]);
    if (!existsSync(join(extracted, "cursor-agent")))
      throw new Error("Pinned Cursor archive has no cursor-agent entry point");
    mkdirSync(target, { recursive: true });
    const versioned = join(target, release.version);
    // Retain an installed version until a completely verified replacement exists.
    const staging = mkdtempSync(join(target, ".cursor-"));
    try {
      const staged = join(staging, "payload");
      cpSync(extracted, staged, { recursive: true });
      rmSync(versioned, { recursive: true, force: true });
      renameSync(staged, versioned);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    console.log(join(versioned, "cursor-agent"));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
