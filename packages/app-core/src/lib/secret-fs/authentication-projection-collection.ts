/** Bounded authenticated manifest references; collection is ciphertext data, never an owner grant. */
import { bytesToB64 } from "@opensesame/vault-core";
import { Effect } from "effect";
import {
  decodeAuthenticationProjection,
  encodeAuthenticationProjection,
  openAuthenticationProjection,
} from "./authentication-projection.js";
import { revisionOf } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
export type ProjectionGarbage = Readonly<{ path: string; expectedB64: string }>;
export type AuthenticationProjectionCollection = Readonly<{
  tomb: string;
  expectedBody: string;
  nextBody: string;
  records: readonly ProjectionGarbage[];
}>;
export const MAX_PROJECTION_COLLECTION_RECORDS = 32;
const MANAGED = /^secrets\/generation-([a-f0-9]{64})\.json$/u;
function unavailable(): never {
  throw new Error("Original projection collection is unavailable.");
}
/** The physical executor calls this itself with its original exact bytes and actual key. */
export async function prepareAuthenticationProjectionCollection(
  tomb: string,
  wire: string,
  key: CryptoKey,
  original: () => void,
): Promise<AuthenticationProjectionCollection> {
  original();
  const snapshot = decodeAuthenticationProjection(tomb, wire);
  await openAuthenticationProjection(tomb, wire, key);
  original();
  const projected = await Effect.runPromise(
    readProjection(makeMemorySecretFiles(snapshot), tomb, key),
  );
  original();
  if (!projected) unavailable();
  const referenced = new Set(
    [...projected.state.items.values()].map((entry) => entry.file),
  );
  const retained = new Map(snapshot);
  const records: ProjectionGarbage[] = [];
  for (const [path, bytes] of snapshot) {
    const relative = path.slice(tomb.length + 1);
    const match = MANAGED.exec(relative);
    if (!match) continue;
    if (match[1] !== revisionOf(bytes)) unavailable();
    if (
      referenced.has(relative) ||
      records.length >= MAX_PROJECTION_COLLECTION_RECORDS
    )
      continue;
    records.push(
      Object.freeze({ path: relative, expectedB64: bytesToB64(bytes) }),
    );
    retained.delete(path);
  }
  const nextBody = encodeAuthenticationProjection(
    tomb,
    [...retained].map(([path, bytes]) => ({
      path: path.slice(tomb.length + 1),
      bytes,
    })),
  );
  original();
  return Object.freeze({
    tomb,
    expectedBody: wire,
    nextBody,
    records: Object.freeze(records),
  });
}
