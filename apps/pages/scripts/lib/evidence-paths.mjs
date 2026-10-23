import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateSharedTempDir } from "./private-files.mjs";

/** Isolate journeys with the same filename in different feature slots. */
export function captureShotsDirectory(journeyPath) {
  const file =
    journeyPath instanceof URL ? fileURLToPath(journeyPath) : journeyPath;
  return path.join(
    privateSharedTempDir("opensesame-evidence"),
    createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 20),
  );
}
