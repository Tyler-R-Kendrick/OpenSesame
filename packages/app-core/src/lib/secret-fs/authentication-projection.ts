/** Inactive physical snapshot data. Neither its digest nor a root input grants authority. */
import {
  type VaultBody,
  b64ToBytes,
  bytesToB64,
  openJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { z } from "zod";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import { SecretFsNotFound, SecretFsRejected } from "./errors.js";
import { type SecretFiles, checkPath, revisionOf } from "./files.js";
import { readProjection } from "./projection-read.js";

export const NODE_PROJECTION_FORMAT =
  "opensesame.node-authentication-projection";
export const NODE_PROJECTION_FILE_LIMIT = 512;
export const NODE_PROJECTION_BYTE_LIMIT = 3 * 1024 * 1024;
export const NODE_PROJECTION_WIRE_LIMIT = 5 * 1024 * 1024;
const schema = z.strictObject({
  format: z.literal(NODE_PROJECTION_FORMAT),
  version: z.literal(1),
  tomb: z.string().min(1).max(200),
  records: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(900),
        bytesB64: z.string(),
      }),
    )
    .max(NODE_PROJECTION_FILE_LIMIT),
});
const sealedBody = z.strictObject({ ivB64: z.string(), ctB64: z.string() });
const revision = z.number().int().nonnegative().safe();
export type ProjectionRecord = Readonly<{ path: string; bytes: Uint8Array }>;
function refuse(): never {
  throw new Error("Physical Node authentication projection is invalid.");
}

/** Stable exact file bytes, not randomized reconstruction ciphertext. */
export function encodeAuthenticationProjection(
  tomb: string,
  records: readonly ProjectionRecord[],
): string {
  const sorted = [...records].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const wire = JSON.stringify({
    format: NODE_PROJECTION_FORMAT,
    version: 1,
    tomb,
    records: sorted.map(({ path, bytes }) => ({
      path,
      bytesB64: bytesToB64(bytes),
    })),
  });
  decodeAuthenticationProjection(tomb, wire);
  return wire;
}

export function decodeAuthenticationProjection(
  tomb: string,
  wire: string,
): ReadonlyMap<string, Uint8Array> {
  assertUnambiguousJson(wire, NODE_PROJECTION_WIRE_LIMIT);
  const parsed = schema.parse(JSON.parse(wire));
  Effect.runSync(checkPath(tomb));
  if (parsed.tomb !== tomb || JSON.stringify(parsed) !== wire) refuse();
  let total = 0;
  let prior = "";
  const files = new Map<string, Uint8Array>();
  for (const record of parsed.records) {
    Effect.runSync(checkPath(record.path));
    if (record.path <= prior || record.path === "header.json") refuse();
    prior = record.path;
    const bytes = b64ToBytes(record.bytesB64);
    if (bytesToB64(bytes) !== record.bytesB64) refuse();
    total += bytes.length;
    if (total > NODE_PROJECTION_BYTE_LIMIT) refuse();
    // All these actual layout files are JSON documents. Reject transport aliases first.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertUnambiguousJson(text, NODE_PROJECTION_BYTE_LIMIT);
    files.set(`${tomb}/${record.path}`, bytes);
  }
  return files;
}

function immutableSnapshotFiles(
  snapshot: ReadonlyMap<string, Uint8Array>,
): SecretFiles {
  const readonlyFailure = (path: string) =>
    new SecretFsRejected({
      path,
      kind: "permission",
      reason: "Authentication snapshots cannot mutate storage.",
    });
  return {
    read: (path) => {
      const bytes = snapshot.get(path);
      return bytes
        ? Effect.succeed({ bytes: bytes.slice(), revision: revisionOf(bytes) })
        : Effect.fail(new SecretFsNotFound({ path }));
    },
    write: (path) => Effect.fail(readonlyFailure(path)),
    remove: (path) => Effect.fail(readonlyFailure(path)),
    list: (prefix) =>
      Effect.succeed(
        [...snapshot.keys()]
          .filter((path) => path === prefix || path.startsWith(`${prefix}/`))
          .sort(),
      ),
  };
}

/** Existing AES/AAD/manifest-list revision checks run against the exact captured bytes. */
export async function openAuthenticationProjection(
  tomb: string,
  wire: string,
  derivedKey: CryptoKey,
): Promise<VaultBody> {
  const snapshot = decodeAuthenticationProjection(tomb, wire);
  const projected = await Effect.runPromise(
    readProjection(immutableSnapshotFiles(snapshot), tomb, derivedKey),
  );
  const flat = snapshot.get(`${tomb}/body.json`);
  let body = projected?.body;
  if (flat) {
    const blob = sealedBody.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(flat)),
    );
    const legacy = await openJson<VaultBody>(
      derivedKey,
      blob,
      vaultSealBinding(tomb, "body"),
    );
    const legacyRevision = revision.parse(legacy.rev ?? 0);
    if (!body || legacyRevision > revision.parse(body.rev ?? 0)) body = legacy;
  }
  if (
    !body ||
    body.v !== 1 ||
    !Array.isArray(body.items) ||
    !Array.isArray(body.folders)
  )
    refuse();
  revision.parse(body.rev ?? 0);
  return body;
}
