/** Exact bounded ciphertext transition validation; no decryption or owner grant. */
import { bytesToB64 } from "@opensesame/vault-core";
import { z } from "zod";
import type { AuthenticationProjectionPlan } from "./authentication-projection-plan.js";
import {
  NODE_PROJECTION_BYTE_LIMIT,
  NODE_PROJECTION_FILE_LIMIT,
  NODE_PROJECTION_WIRE_LIMIT,
  decodeAuthenticationProjection,
} from "./authentication-projection.js";
const byteText = z.string().max(Math.ceil(NODE_PROJECTION_BYTE_LIMIT / 3) * 4);
const write = z.strictObject({
  path: z.string().min(1).max(900),
  expectedB64: byteText.nullable(),
  nextB64: byteText,
});
const plan = z.strictObject({
  tomb: z.string().min(1).max(200),
  expectedBody: z.string().max(NODE_PROJECTION_WIRE_LIMIT),
  nextBody: z.string().max(NODE_PROJECTION_WIRE_LIMIT),
  documents: z.array(write).max(NODE_PROJECTION_FILE_LIMIT),
  manifest: write,
});
function unavailable(): never {
  throw new Error("Encrypted projection transition is invalid.");
}
export function readAuthenticationProjectionTransition(
  input: AuthenticationProjectionPlan,
): AuthenticationProjectionPlan {
  const parsed = plan.parse(input);
  const before = decodeAuthenticationProjection(
    parsed.tomb,
    parsed.expectedBody,
  );
  const after = decodeAuthenticationProjection(parsed.tomb, parsed.nextBody);
  if (parsed.manifest.path !== "vault.json") unavailable();
  const changes = [...parsed.documents, parsed.manifest];
  const seen = validateWrites(changes, parsed.tomb, before, after);
  for (const document of parsed.documents)
    if (!document.path.startsWith("secrets/") || document.expectedB64 !== null)
      unavailable();
  for (const path of before.keys()) if (!after.has(path)) unavailable();
  let expectedChanges = 0;
  for (const [path, next] of after) {
    const old = before.get(path);
    if (old && bytesToB64(old) === bytesToB64(next)) continue;
    expectedChanges += 1;
    if (!seen.has(path.slice(parsed.tomb.length + 1))) unavailable();
  }
  if (expectedChanges !== changes.length) unavailable();
  return Object.freeze({
    ...parsed,
    documents: Object.freeze(
      parsed.documents.map((document) => Object.freeze(document)),
    ),
    manifest: Object.freeze(parsed.manifest),
  });
}

function validateWrites(
  changes: readonly AuthenticationProjectionPlan["manifest"][],
  tomb: string,
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>,
): Set<string> {
  const seen = new Set<string>();
  let bytes = 0;
  for (const change of changes) {
    if (seen.has(change.path) || change.path.split("/").length > 8)
      unavailable();
    seen.add(change.path);
    bytes += change.nextB64.length + (change.expectedB64?.length ?? 0);
    if (bytes > Math.ceil((NODE_PROJECTION_BYTE_LIMIT * 2) / 3) * 4)
      unavailable();
    const old = before.get(`${tomb}/${change.path}`);
    const next = after.get(`${tomb}/${change.path}`);
    if (
      !next ||
      change.expectedB64 !== (old ? bytesToB64(old) : null) ||
      change.nextB64 !== bytesToB64(next) ||
      change.nextB64 === change.expectedB64
    )
      unavailable();
  }
  return seen;
}
