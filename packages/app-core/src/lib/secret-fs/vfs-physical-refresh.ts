/** Bounded reads from the original file store; ciphertext DATA, never an admission. */
import { Effect } from "effect";
import { decodeConfig } from "./config-docs.js";
import { SecretFsRejected } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { LEGACY_BODY_FILE, type TombProjection } from "./secret-docs.js";
export type PhysicalFileLocation =
  | Readonly<{ kind: "file"; file: string; path: string }>
  | Readonly<{ kind: "body"; tomb: string }>;
function decodePhysicalValue(
  bytes: Uint8Array,
  where: PhysicalFileLocation,
  path: string,
  maxBytes: number,
) {
  const config = where.kind === "file" ? decodeConfig(bytes) : null;
  if (config && (where.kind !== "file" || config.path !== where.path))
    throw new SecretFsRejected({
      path,
      kind: "corrupt",
      reason: "Physical configuration path differs.",
    });
  const value =
    config?.value ?? new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (new TextEncoder().encode(value).length > maxBytes)
    throw new SecretFsRejected({
      path,
      kind: "corrupt",
      reason: "Decoded record exceeds read limit.",
    });
  return value;
}
export function captureFileBackedPhysicalRefresh(
  files: SecretFiles,
  mirror: Map<string, string>,
  projections: Map<string, TombProjection>,
  refreshed: Set<string>,
  locate: (key: string) => PhysicalFileLocation,
) {
  const read = files.read;
  return async (
    key: string,
    maxBytes: number,
    original: () => void = () => {},
  ) => {
    const check = () => {
      original();
      if (files.read !== read) throw new Error("Original file reader changed.");
    };
    check();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid physical read limit.");
    const where = locate(key);
    // Invalidate flat BODY and revision caches before any current physical read.
    refreshed.add(key);
    mirror.delete(key);
    if (where.kind === "body") projections.delete(where.tomb);
    const path =
      where.kind === "body" ? `${where.tomb}/${LEGACY_BODY_FILE}` : where.file;
    try {
      const found = await Effect.runPromise(
        read
          .call(files, path)
          .pipe(
            Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null)),
          ),
      );
      check();
      if (found === null) return;
      if (found.bytes.length > maxBytes)
        throw new SecretFsRejected({
          path,
          kind: "corrupt",
          reason: "Physical record exceeds read limit.",
        });
      const value = decodePhysicalValue(found.bytes, where, path, maxBytes);
      check();
      mirror.set(key, value);
    } catch (error) {
      mirror.delete(key);
      throw error;
    }
  };
}
