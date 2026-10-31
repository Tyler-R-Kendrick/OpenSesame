/** A build cache hit is usable only when every pinned source and shipped byte agrees. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { string } from "zod/v4/mini";
import { compressorArchivePin } from "./compressor-archive.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const PublicRootsVersion = string();
async function exactFile(path, expected, max = 1_048_576) {
  if (
    !digestPattern.test(expected?.sha256 ?? "") ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > max
  )
    throw new Error("Invalid pinned native asset metadata.");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Native assets must be regular owned files.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected.bytes)
      throw new Error("Native asset size differs.");
    const bytes = await handle.readFile();
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
      throw new Error("Native asset digest differs.");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function pinnedText(path, digest, max = 65_536) {
  if (!digestPattern.test(digest))
    throw new Error("Invalid native source pin.");
  const info = await lstat(path);
  const bytes = await exactFile(
    path,
    { bytes: info.size, sha256: digest },
    max,
  );
  return bytes.toString("utf8");
}
/** Fixed pinned overlay groups; no generic directory loader or ambient compiler selection. */
export async function assertNativeSourceInputs(here, expectedSourceSha256) {
  const source = JSON.parse(
    await pinnedText(join(here, "source.json"), expectedSourceSha256),
  );
  const files = [
    ...source.nativeHttp.files,
    ...source.nativeBridge.files,
    ...source.nativeNode.files,
    source.nativeNode.stagingHelper,
    ...source.toolchainSelection.files,
    ...source.privateLogging.files,
    ...source.publicTrust.files,
    ...(source.peerGET?.files ?? []),
    ...(source.peerGET
      ? [source.peerGET.patch, source.peerGET.stagingHelper]
      : []),
    source.nativeSSH.patch,
    source.nativeSSH.stagingHelper,
    ...source.composition.files,
    { path: "exit-route.patch", sha256: source.patch.sha256 },
  ];
  const seen = new Map();
  for (const file of files) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(file.path) ||
      file.path === "." ||
      file.path === ".."
    )
      throw new Error("Invalid native source path.");
    const previous = seen.get(file.path);
    if (previous && previous !== file.sha256)
      throw new Error("Conflicting native source pins.");
    if (file.path === compressorArchivePin.path) {
      if (file.sha256 !== compressorArchivePin.sha256)
        throw new Error("Native compressor source pin differs.");
      await exactFile(
        join(here, file.path),
        {
          bytes: compressorArchivePin.bytes,
          sha256: compressorArchivePin.sha256,
        },
        compressorArchivePin.bytes,
      );
    } else await pinnedText(join(here, file.path), file.sha256);
    seen.set(file.path, file.sha256);
  }
  return source;
}
function assetPaths(manifest) {
  const entries = [
    [
      "wasm",
      manifest.assets?.wasm,
      /^tailscale\/main-[a-f0-9]{16}\.wasm\.gz$/,
      16_777_216,
    ],
    [
      "runtime",
      manifest.assets?.runtime,
      /^tailscale\/go-runtime-[a-f0-9]{16}\.js$/,
      1_048_576,
    ],
    [
      "nativeHTTP",
      manifest.assets?.nativeHTTP,
      /^tailscale\/native-http-[a-f0-9]{16}\.js$/,
      1_048_576,
    ],
    ["license", manifest.license, /^tailscale\/LICENSE\.txt$/, 1_048_576],
    [
      "notices",
      manifest.upstreamNotices,
      /^tailscale\/OPEN-SOURCE-LICENSES\.md$/,
      1_048_576,
    ],
  ];
  for (const [kind, value, pattern] of entries) {
    if (!pattern.test(value?.path ?? ""))
      throw new Error("Invalid native distribution path.");
    if (
      ["wasm", "runtime", "nativeHTTP"].includes(kind) &&
      !value.path.includes(value.sha256?.slice(0, 16))
    )
      throw new Error("Native asset name is not its pinned digest.");
  }
  return entries;
}
function assertRawWasm(manifest, assets) {
  const raw = manifest.rawWasm;
  if (
    !digestPattern.test(raw?.sha256 ?? "") ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 8 ||
    raw.bytes > 67_108_864
  )
    throw new Error("Invalid native WASM metadata.");
  const wasm = gunzipSync(assets.get(manifest.assets.wasm.path), {
    maxOutputLength: raw.bytes,
  });
  if (
    wasm.length !== raw.bytes ||
    hash(wasm) !== raw.sha256 ||
    !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
    !WebAssembly.validate(wasm)
  )
    throw new Error("Native compressed/raw WASM differs.");
}
/** Read only the exact accepted compiled distribution; never fall back to the old npm WASM. */
export async function readNativeDistribution(
  directory,
  expectedManifestSha256,
) {
  const folder = await lstat(join(directory, "tailscale"));
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error("Native assets must be an owned directory.");
  const manifest = JSON.parse(
    await pinnedText(
      join(directory, "native-artifacts.json"),
      expectedManifestSha256,
    ),
  );
  if (
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "") ||
    !/^[a-f0-9]{40}$/.test(manifest.compilerCommit ?? "") ||
    !PublicRootsVersion.safeParse(manifest.publicRootsVersion).success
  )
    throw new Error("Native distribution provenance is missing.");
  const assets = new Map();
  for (const [, value, , maximum] of assetPaths(manifest)) {
    assets.set(
      value.path,
      await exactFile(join(directory, value.path), value, maximum),
    );
  }
  assertRawWasm(manifest, assets);
  return { manifest, assets };
}
