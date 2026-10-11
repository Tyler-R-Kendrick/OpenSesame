/** Strict bounded encrypted auxiliary snapshots only. No file enumeration, owner grant or unindexed legacy fallback. */
import { z } from "zod";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
export const NODE_AUXILIARY_LIMIT = 4 * 1024 * 1024;
export const NODE_AUXILIARY_FILES = 128;
const blob = z.strictObject({
  ivB64: z.string().max(32),
  ctB64: z.string().max(NODE_AUXILIARY_LIMIT),
});
export const nodeAuxiliarySnapshotSchema = z.strictObject({
  index: z.string().nullable(),
  records: z
    .array(z.strictObject({ path: z.string(), body: z.string() }))
    .max(NODE_AUXILIARY_FILES),
});
export type NodeAuxiliarySnapshot = z.infer<typeof nodeAuxiliarySnapshotSchema>;
function unavailable(): never {
  throw new Error("Original Node auxiliary generation unavailable.");
}
export function requireNodeAuxiliaryPath(tomb: string, path: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(tomb) ||
    new TextEncoder().encode(`tomb/${tomb}/${path}`).length > 511 ||
    !path
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)) ||
    [
      "index",
      "header",
      "body",
      "migrated.v1",
      "seal-bound.v1",
      "retired-credentials.v1",
      "retired-credentials.v2",
    ].includes(path)
  )
    unavailable();
}
export function readNodeAuxiliaryBlob(wire: string) {
  assertUnambiguousJson(wire, NODE_AUXILIARY_LIMIT);
  return blob.parse(JSON.parse(wire));
}
/** Copies every caller string/array before any await. Logical paths address records only, never arbitrary files. */
export function copyNodeAuxiliarySnapshot(
  tomb: string,
  proposed: NodeAuxiliarySnapshot,
): NodeAuxiliarySnapshot {
  const next = nodeAuxiliarySnapshotSchema.parse(proposed);
  if (
    new TextEncoder().encode(JSON.stringify(next)).length > NODE_AUXILIARY_LIMIT
  )
    unavailable();
  if (next.index === null && next.records.length !== 0) unavailable();
  if (next.index !== null) readNodeAuxiliaryBlob(next.index);
  const paths = new Set<string>();
  for (const record of next.records) {
    requireNodeAuxiliaryPath(tomb, record.path);
    if (paths.has(record.path)) unavailable();
    paths.add(record.path);
    readNodeAuxiliaryBlob(record.body);
    Object.freeze(record);
  }
  next.records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  Object.freeze(next.records);
  return Object.freeze(next);
}
