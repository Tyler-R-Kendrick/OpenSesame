/** Copy-on-write ciphertext generations keep the previous manifest readable until commit. */
import { bytesToB64 } from "@opensesame/vault-core";
import { Effect } from "effect";
import { revisionOf } from "./files.js";
import {
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  type ManifestPayload,
  decodeManifestDoc,
  encode,
  manifestBinding,
  opened,
  sealed,
} from "./secret-docs.js";
function unavailable(): never {
  throw new Error("Original encrypted projection generation is unavailable.");
}
export async function retainProjectionGenerations(
  tomb: string,
  before: ReadonlyMap<string, Uint8Array>,
  planned: ReadonlyMap<string, Uint8Array>,
  key: CryptoKey,
  original: () => void,
): Promise<ReadonlyMap<string, Uint8Array>> {
  original();
  const manifestPath = `${tomb}/${MANIFEST_FILE}`;
  const manifest = planned.get(manifestPath);
  if (!manifest) unavailable();
  const doc = await Effect.runPromise(
    decodeManifestDoc(manifest, manifestPath),
  );
  const payload = await Effect.runPromise(
    opened<ManifestPayload>(
      key,
      doc.sealed,
      manifestBinding(tomb),
      manifestPath,
    ),
  );
  original();
  const retained = new Map(before);
  const replacements = new Map<string, string>();
  for (const [path, bytes] of planned) {
    if (path === manifestPath) continue;
    const prior = before.get(path);
    if (prior && bytesToB64(prior) === bytesToB64(bytes)) continue;
    if (!path.startsWith(`${tomb}/secrets/`)) unavailable();
    const relative = `secrets/generation-${revisionOf(bytes)}.json`;
    const target = `${tomb}/${relative}`;
    // A generation is always newly created; never replace previous ciphertext.
    if (before.has(target) || retained.has(target)) unavailable();
    retained.set(target, bytes.slice());
    replacements.set(path.slice(tomb.length + 1), relative);
  }
  const listing = (entry: ManifestPayload["items"][number]) => ({
    ...entry,
    file: replacements.get(entry.file) ?? entry.file,
  });
  const next: ManifestPayload = {
    ...payload,
    items: payload.items.map(listing),
    folders: payload.folders.map((entry) =>
      "file" in entry ? listing(entry) : entry,
    ),
  };
  const blob = await Effect.runPromise(
    sealed(key, next, manifestBinding(tomb), manifestPath),
  );
  original();
  retained.set(
    manifestPath,
    encode({ format: MANIFEST_FORMAT, version: 1, sealed: blob }),
  );
  return retained;
}
