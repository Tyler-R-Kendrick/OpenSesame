/** Exact reviewed build-tool source. Never emitted as a PWA deployment asset. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const compressorArchivePin = Object.freeze({
  version: "2.8",
  path: "pigz-2.8.tar.gz",
  sourceURL: "https://zlib.net/pigz/pigz-2.8.tar.gz",
  bytes: 121304,
  sha256: "eb872b4f0e1f0ebe59c9f7bd8c506c4204893ba6a8492de31df416f0d5170fd0",
});

/** Size/ownership are checked before reading; only pinned bytes reach the caller. */
export async function readCompressorArchive(
  file = new URL(compressorArchivePin.path, import.meta.url),
) {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Native compressor source must be a regular owned file.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== compressorArchivePin.bytes)
      throw new Error(
        "Native compressor archive size differs from its official pin.",
      );
    const bytes = await handle.readFile();
    if (
      bytes.length !== compressorArchivePin.bytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        compressorArchivePin.sha256
    )
      throw new Error(
        "Native compressor archive differs from its official pin.",
      );
    return bytes;
  } finally {
    await handle.close();
  }
}
