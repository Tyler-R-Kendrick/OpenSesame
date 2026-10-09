/** Existing registry/index parsing only; receives no owner or admission. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type SealedBlob, b64ToBytes } from "@opensesame/vault-core";
import { VfsError } from "./vfs-error.js";

export type TombsRegistry = { v: 1; tombs: string[] };
export type TombIndex = { v: 1; files: Record<string, number> };
export function parseRegistry(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.tombs)) return [];
    return parsed.tombs.filter(isString);
  } catch {
    return [];
  }
}
export function parseIndex(value: BoundaryValue): TombIndex {
  if (!isJsonObject(value) || !isJsonObject(value.files))
    return { v: 1, files: {} };
  const files: Record<string, number> = {};
  for (const [path, rev] of Object.entries(value.files)) {
    if (isNumber(rev)) files[path] = rev;
  }
  return { v: 1, files };
}

const TOMB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertTombName(tomb: string): void {
  if (!TOMB_NAME_RE.test(tomb)) {
    throw new VfsError(
      "invalid-path",
      `Invalid tomb name: ${JSON.stringify(tomb)}`,
    );
  }
}

export function assertFilePath(path: string): void {
  const segments = path.split("/");
  if (segments.some((segment) => !PATH_SEGMENT_RE.test(segment))) {
    throw new VfsError(
      "invalid-path",
      `Invalid VFS path: ${JSON.stringify(path)}`,
    );
  }
}

export function isSealedBlob(value: BoundaryValue): value is SealedBlob {
  return isJsonObject(value) && isString(value.ivB64) && isString(value.ctB64);
}

export function parseSealedBlob(
  raw: string,
  tomb: string,
  path: string,
): SealedBlob {
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (isSealedBlob(parsed)) return parsed;
  } catch {
    /* fall through to the typed error */
  }
  throw new VfsError(
    "corrupt",
    `tomb "${tomb}" file "${path}" is not a sealed blob.`,
  );
}

/** Sealed content envelope: base64 bytes inside the AES-GCM SealedBlob. */
export type SealedFileEnvelope = { v: 1; dataB64: string };

export function parseEnvelope(
  value: BoundaryValue,
  tomb: string,
  path: string,
): Uint8Array {
  if (isJsonObject(value) && value.v === 1 && isString(value.dataB64)) {
    return b64ToBytes(value.dataB64);
  }
  throw new VfsError(
    "corrupt",
    `tomb "${tomb}" file "${path}" sealed an unexpected payload.`,
  );
}
