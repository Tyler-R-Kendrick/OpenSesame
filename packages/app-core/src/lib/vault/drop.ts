import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Secret drop transport (docs/design/secret-drop.md, ADR 0062).
 *
 * A drop shares a secret or a small file exactly once: the browser seals the
 * payload under a fresh AES-GCM-256 drop key, the sealed manifest rides a
 * claim session (`type: "resource_bundle"`, in-manifest discriminator
 * `kind: "secret-drop"`), and the key travels in the drop link's `#key=`
 * fragment — it is never sent to any server. Presentation is single-use and
 * gated by the claim's user code, so the server serves the ciphertext
 * exactly once, to whoever holds link + code.
 *
 * File payloads follow the ADR 0054 attachment layout, adapted to WebCrypto:
 * 1 MiB plaintext chunks, each sealed on its own, a SHA-256 digest per chunk
 * and one for the whole payload (SHA-256 stands in for BLAKE3 — WebCrypto
 * has no BLAKE3). v1 caps total ciphertext at 1 MiB.
 */

import {
  DropFormatError,
  type DropItem,
  type DropKeptCopy,
  type DropManifest,
  type DropPayload,
  type SealedDrop,
  type VaultItem,
  bytesToB64,
  createItem,
  dropTerminal,
  guardManifest as guardManifestFormat,
  openDrop as openDropFormat,
  sealDrop as sealDropFormat,
} from "@opensesame/vault-core";
import {
  DropTransportError,
  type DropTransportErrorCode,
  dropSeams,
} from "./drop-transport.js";

export {
  DROP_CHUNK_BYTES,
  type DropChunk,
  type DropFilePayload,
  type DropManifest,
  type DropPayload,
  type DropTextPayload,
  MAX_DROP_CIPHERTEXT_BYTES,
  type SealedDrop,
} from "@opensesame/vault-core";

/** Terminal states purge the vault's drop record; `pending` keeps waiting. */
export type DropState = "pending" | "consumed" | "expired";

export type DropSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  /** Ceremonies claim URL the recipient opens; `dropLink` adds the fragment. */
  verifyUrl: string;
  expiresAt: string;
};

/**
 * Sealing and opening refusals from the format (`payload_too_large` …
 * `tampered`), and the transport's — which, on opening, say why the claim
 * plane refused (`invalid_code`, `already_opened`, `expired`, `invalid`).
 */
export type DropErrorCode =
  | "payload_too_large"
  | "invalid_manifest"
  | "invalid_key"
  | "tampered"
  | DropTransportErrorCode;

export class DropError extends Error {
  constructor(
    readonly code: DropErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropError";
  }
}

/* ------------------------------------------------------ claim transport */

/** A format refusal, restated as this side's error; anything else as is. */
function asDropError(error: Error): never {
  if (error instanceof DropFormatError)
    throw new DropError(error.code, error.message);
  throw error;
}

/** Seal a payload under a fresh drop key (see `@opensesame/vault-core`). */
export function sealDrop(payload: DropPayload): Promise<SealedDrop> {
  return sealDropFormat(payload).catch(asDropError);
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardManifest(value: BoundaryValue): DropManifest {
  try {
    return guardManifestFormat(value);
  } catch (error) {
    if (error instanceof Error) asDropError(error);
    throw error;
  }
}

/** Decrypt and digest-verify a presented drop manifest. */
export function openDrop(
  value: BoundaryValue,
  fragmentKey: string,
): Promise<DropPayload> {
  return openDropFormat(value, fragmentKey).catch(asDropError);
}

function obj(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

/** Claim lifecycle states the server reports, mapped onto drop states. */
export function dropStateFromClaim(status: string): DropState {
  switch (status) {
    case "pending":
      return "pending";
    case "presented":
    case "authenticated":
    case "reviewed":
    case "completed":
      // Presentation is the single-use burn: from the drop's side the payload
      // was taken the moment the claim was presented.
      return "consumed";
    case "expired":
    case "denied":
    case "revoked":
      return "expired";
    default:
      throw new DropError(
        "refused",
        "The claim plane reported a state this app does not know.",
      );
  }
}

function mapTransportError(error: Error): DropError {
  if (error instanceof DropError) return error;
  if (error instanceof DropTransportError) {
    return new DropError(error.code, error.message);
  }
  return new DropError("unreachable", error.message);
}

export type PresentedDrop = {
  targetManifest: DropManifest;
};

/** Create the single-use, time-boxed claim session carrying this manifest. */
export async function createDropSession(
  manifest: DropManifest,
  ttlMs: number,
): Promise<DropSession> {
  try {
    // SAFETY: DropManifest is a JsonObject (kind + sealed fields).
    return await dropSeams.createClaim(overlapCast(manifest), ttlMs);
  } catch (error) {
    throw mapTransportError(
      error instanceof Error ? error : new Error("drop claim create failed"),
    );
  }
}

/** Map the claim's current state onto the drop record's lifecycle. */
export async function pollDrop(
  claimId: string,
  bearerToken: string,
): Promise<DropState> {
  try {
    const status = await dropSeams.pollClaim(claimId, bearerToken);
    // Local host already returns drop states; Identity poll returns claim states.
    if (status === "pending" || status === "consumed" || status === "expired") {
      return status;
    }
    return dropStateFromClaim(status);
  } catch (error) {
    throw mapTransportError(
      error instanceof Error ? error : new Error("drop claim poll failed"),
    );
  }
}

/** Open a drop once — user code + bearer; returns the sealed manifest. */
export async function presentDrop(
  bearerToken: string,
  userCode: string,
): Promise<PresentedDrop> {
  try {
    const presented = await dropSeams.presentClaim(bearerToken, userCode);
    return { targetManifest: guardManifest(presented.targetManifest) };
  } catch (error) {
    throw mapTransportError(
      error instanceof Error ? error : new Error("drop claim present failed"),
    );
  }
}

export { dropSeams };

/**
 * The shareable link: ceremonies claim URL with the bearer and the drop key
 * in the fragment. The fragment never leaves the browser — no request line,
 * log, or Referer ever carries it.
 */
export function dropLink(
  verifyUrl: string,
  bearerToken: string,
  fragmentKey: string,
): string {
  return `${verifyUrl}#token=${encodeURIComponent(bearerToken)}&key=${fragmentKey}`;
}

/* ------------------------------------------------------------- creation */

export type CreatedDrop = {
  /** The vault record — no payload inside unless `keepCopy` was asked for. */
  record: DropItem;
  link: string;
  userCode: string;
};

/**
 * Seal a payload, create its claim session, and build the vault record for
 * it. The record still has to be saved by the caller, so a failed save never
 * leaves a drop nobody can track.
 */
export async function createDrop(input: {
  name: string;
  payload: DropPayload;
  ttlMs: number;
  keepCopy: boolean;
}): Promise<CreatedDrop> {
  const { manifest, fragmentKey } = await sealDrop(input.payload);
  const session = await createDropSession(manifest, input.ttlMs);
  const record: DropItem = {
    ...createItem("drop", input.name),
    state: "pending",
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    expiresAt: session.expiresAt,
    ...(input.keepCopy
      ? { keptCopy: keptCopyFromPayload(input.payload) }
      : undefined),
  };
  return {
    record,
    link: dropLink(session.verifyUrl, session.bearerToken, fragmentKey),
    userCode: session.userCode,
  };
}

/* ----------------------------------------------------------- kept copies */

/** JSON-safe form of a payload for the drop record's optional kept copy. */
export function keptCopyFromPayload(payload: DropPayload): DropKeptCopy {
  if (payload.kind === "text") {
    return { kind: "text", text: payload.text };
  }
  return {
    kind: "file",
    name: payload.name,
    contentType: payload.contentType,
    dataB64: bytesToB64(payload.bytes),
  };
}

/* -------------------------------------------------------------- disposal */

/**
 * Poll one drop record and purge it once nothing can open the drop again:
 * the claim reached a terminal state, or the TTL already lapsed locally.
 * Only an affirmative terminal answer purges — a network or refusal failure
 * leaves the record for the next read, so a shaky connection never burns a
 * live drop.
 */
export async function sweepDrop(
  item: DropItem,
  purge: () => Promise<void>,
  now = new Date(),
): Promise<void> {
  if (dropTerminal(item, now)) {
    await purge();
    return;
  }
  try {
    const state = await pollDrop(item.claimId, item.bearerToken);
    if (state !== "pending") await purge();
  } catch {
    // Offline or refused: the record stays; the next vault read retries.
  }
}

/** Sweep every live drop record after the vault body is read. */
export async function sweepDrops(
  items: VaultItem[],
  purge: (id: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    if (item.kind !== "drop" || item.deletedAt !== null) continue;
    await sweepDrop(item, () => purge(item.id));
  }
}
