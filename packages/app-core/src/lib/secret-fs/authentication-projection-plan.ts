/** Cryptographic projection data planning only. This map is never persistence or authority. */
import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type VaultBody,
  bytesToB64,
  normalizeVaultBody,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { retainProjectionGenerations } from "./authentication-projection-generations.js";
import {
  NODE_PROJECTION_BYTE_LIMIT,
  decodeAuthenticationProjection,
  encodeAuthenticationProjection,
  openAuthenticationProjection,
} from "./authentication-projection.js";
import { makeMemorySecretFiles } from "./memory.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import { EMPTY_PROJECTION, MANIFEST_FILE } from "./secret-docs.js";
export type ProjectionRecordWrite = Readonly<{
  path: string;
  expectedB64: string | null;
  nextB64: string;
}>;
export type AuthenticationProjectionPlan = Readonly<{
  tomb: string;
  expectedBody: string;
  nextBody: string;
  documents: readonly ProjectionRecordWrite[];
  manifest: ProjectionRecordWrite;
}>;
function unavailable(): never {
  throw new Error("Original encrypted projection plan is unavailable.");
}
function relativeRecords(tomb: string, files: ReadonlyMap<string, Uint8Array>) {
  return [...files].map(([path, bytes]) => {
    if (!path.startsWith(`${tomb}/`)) unavailable();
    return { path: path.slice(tomb.length + 1), bytes };
  });
}
/** A private caller has already proved its key and merged body; output is ciphertext only. */
export async function prepareAuthenticationProjectionPlan(
  tomb: string,
  expectedBody: string,
  nextBody: VaultBody,
  key: CryptoKey,
  original: () => void,
): Promise<AuthenticationProjectionPlan> {
  original();
  const plain = JSON.stringify(nextBody);
  if (new TextEncoder().encode(plain).length > NODE_PROJECTION_BYTE_LIMIT)
    unavailable();
  const next = normalizeVaultBody(overlapCast(JSON.parse(plain)));
  const expected = decodeAuthenticationProjection(tomb, expectedBody);
  const current = await openAuthenticationProjection(tomb, expectedBody, key);
  original();
  if (!Number.isSafeInteger(next.rev) || next.rev !== (current.rev ?? 0) + 1)
    unavailable();
  const files = makeMemorySecretFiles(expected);
  const projected = await Effect.runPromise(readProjection(files, tomb, key));
  original();
  await Effect.runPromise(
    writeProjection(
      files,
      tomb,
      key,
      next,
      projected?.state ?? EMPTY_PROJECTION,
    ),
  );
  original();
  // Preserve unlisted ciphertext: cleanup is separate from the authenticated commit.
  const retained = await retainProjectionGenerations(
    tomb,
    expected,
    files.snapshot(),
    key,
    original,
  );
  original();
  const nextWire = encodeAuthenticationProjection(
    tomb,
    relativeRecords(tomb, retained),
  );
  const verified = await openAuthenticationProjection(tomb, nextWire, key);
  original();
  if (canonicalBody(verified) !== canonicalBody(next)) unavailable();
  const documents: ProjectionRecordWrite[] = [];
  let manifest: ProjectionRecordWrite | undefined;
  for (const { path, bytes } of relativeRecords(tomb, retained).sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const old = expected.get(`${tomb}/${path}`);
    const nextB64 = bytesToB64(bytes);
    const expectedB64 = old ? bytesToB64(old) : null;
    if (nextB64 === expectedB64) continue;
    const write = Object.freeze({ path, expectedB64, nextB64 });
    if (path === MANIFEST_FILE) manifest = write;
    else documents.push(write);
  }
  if (!manifest) unavailable();
  original();
  return Object.freeze({
    tomb,
    expectedBody,
    nextBody: nextWire,
    documents: Object.freeze(documents),
    manifest,
  });
}

function canonicalBody(body: VaultBody): string {
  return JSON.stringify(body, (_key, value: BoundaryValue) => {
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
}
