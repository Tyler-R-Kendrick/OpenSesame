/**
 * The worker message protocol (B11, RUNTIME-02).
 *
 * Only these operation kinds exist, every message is schema- and
 * size-checked in both directions, and each carries the scope it was
 * minted under so a stale generation or another vault is rejected before
 * any key material moves. There is no generic "run this" verb, no network
 * verb, no filesystem verb, and no way to ask for a root unwrap.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { SopsFormat } from "./document.js";
import { SopsError } from "./errors.js";
import type { Inspection } from "./inspect.js";
import type { RecoveryReport } from "./keys/groups.js";
import type { EncryptionPlan, ExecutionPermit } from "./plan.js";

/** A request body is bounded well above a legitimate document. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type SopsRequest =
  | { id: string; kind: "inspect"; text: string; format: SopsFormat }
  | {
      id: string;
      kind: "open";
      text: string;
      format: SopsFormat;
      identities: string[];
      permit: ExecutionPermit;
    }
  | {
      id: string;
      kind: "saveEdited";
      handle: string;
      edited: string;
      permit: ExecutionPermit;
    }
  | {
      id: string;
      kind: "encryptNew";
      text: string;
      plan: EncryptionPlan;
      permit: ExecutionPermit;
    }
  | {
      id: string;
      kind: "rotate";
      handle: string;
      edited: string | null;
      plan: EncryptionPlan;
      permit: ExecutionPermit;
    }
  | { id: string; kind: "dispose"; handle: string }
  | { id: string; kind: "invalidate"; generation: number };

/** `Omit` over a union collapses its variants; this keeps them apart. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A request without its id, so the client can mint one per call. */
export type SopsRequestBody = DistributiveOmit<SopsRequest, "id">;

export type SopsResponse =
  | { id: string; ok: true; kind: "inspect"; inspection: Inspection }
  | {
      id: string;
      ok: true;
      kind: "open";
      handle: string;
      plaintext: string;
      inspection: Inspection;
      report: RecoveryReport;
    }
  | { id: string; ok: true; kind: "output"; output: string }
  | { id: string; ok: true; kind: "done" }
  | { id: string; ok: false; code: SopsError["code"]; message: string };

const KINDS = new Set([
  "inspect",
  "open",
  "saveEdited",
  "encryptNew",
  "rotate",
  "dispose",
  "invalidate",
]);

function isStringArray(value: BoundaryValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

/** A permit must carry a whole scope; a partial one cannot be smuggled in. */
function isPermit(value: BoundaryValue): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.scope)) return false;
  const scope = value.scope;
  return (
    isString(scope.operationId) &&
    isNumber(scope.documentGeneration) &&
    isNumber(scope.sessionGeneration) &&
    (scope.vaultScope === null || isString(scope.vaultScope)) &&
    isString(value.approvedPlanDigest) &&
    (value.network === "forbidden" ||
      value.network === "explicit-providers-only")
  );
}

function isEncryptionPlan(value: BoundaryValue): boolean {
  if (!isJsonObject(value)) return false;
  if (value.format !== "yaml" && value.format !== "json") return false;
  if (!Array.isArray(value.groups)) return false;
  if (!isNumber(value.shamirThreshold)) return false;
  return isJsonObject(value.policy);
}

function reject(message: string): never {
  throw new SopsError("invalid_document", message);
}

function isFormat(value: BoundaryValue): value is "yaml" | "json" {
  return value === "yaml" || value === "json";
}

/** SAFETY: `isPermit` checked every field of the permit contract above. */
function asPermit(value: JsonObject): ExecutionPermit {
  return overlapCast(value);
}

/** SAFETY: `isEncryptionPlan` checked the plan's shape; `validatePlan` checks the rest. */
function asPlan(value: JsonObject): EncryptionPlan {
  return overlapCast(value);
}

type RequestBuilder = (id: string, value: JsonObject) => SopsRequest;
type ResponseBuilder = (id: string, value: JsonObject) => SopsResponse;

const REQUESTS = {
  inspect(id, value) {
    if (!isString(value.text) || !isFormat(value.format)) {
      reject("A malformed inspect request.");
    }
    return { id, kind: "inspect", text: value.text, format: value.format };
  },
  open(id, value) {
    if (!isString(value.text) || !isFormat(value.format)) {
      reject("A malformed open request.");
    }
    if (
      !isStringArray(value.identities) ||
      !isJsonObject(value.permit) ||
      !isPermit(value.permit)
    ) {
      reject("A malformed open request.");
    }
    return {
      id,
      kind: "open",
      text: value.text,
      format: value.format,
      identities: value.identities,
      permit: asPermit(value.permit),
    };
  },
  saveEdited(id, value) {
    if (!isString(value.handle) || !isString(value.edited)) {
      reject("A malformed save request.");
    }
    if (!isJsonObject(value.permit) || !isPermit(value.permit)) {
      reject("A malformed save request.");
    }
    return {
      id,
      kind: "saveEdited",
      handle: value.handle,
      edited: value.edited,
      permit: asPermit(value.permit),
    };
  },
  encryptNew(id, value) {
    if (
      !isString(value.text) ||
      !isJsonObject(value.plan) ||
      !isEncryptionPlan(value.plan)
    ) {
      reject("A malformed encrypt request.");
    }
    if (!isJsonObject(value.permit) || !isPermit(value.permit)) {
      reject("A malformed encrypt request.");
    }
    return {
      id,
      kind: "encryptNew",
      text: value.text,
      plan: asPlan(value.plan),
      permit: asPermit(value.permit),
    };
  },
  rotate(id, value) {
    if (
      !isString(value.handle) ||
      !isJsonObject(value.plan) ||
      !isEncryptionPlan(value.plan)
    ) {
      reject("A malformed rotate request.");
    }
    if (!isJsonObject(value.permit) || !isPermit(value.permit)) {
      reject("A malformed rotate request.");
    }
    if (!(value.edited === null || isString(value.edited))) {
      reject("A malformed rotate request.");
    }
    return {
      id,
      kind: "rotate",
      handle: value.handle,
      edited: value.edited,
      plan: asPlan(value.plan),
      permit: asPermit(value.permit),
    };
  },
  dispose(id, value) {
    if (!isString(value.handle)) reject("A malformed dispose request.");
    return { id, kind: "dispose", handle: value.handle };
  },
  invalidate(id, value) {
    if (!isNumber(value.generation)) reject("A malformed invalidate request.");
    return { id, kind: "invalidate", generation: value.generation };
  },
} satisfies Record<string, RequestBuilder>;

/** Validate an inbound request inside the worker. Throws on anything odd. */
export function parseRequest(value: BoundaryValue): SopsRequest {
  if (!isJsonObject(value)) reject("A worker message is not an object.");
  const id = value.id;
  const kind = value.kind;
  if (!isString(id) || id.length === 0 || id.length > 64) {
    reject("A worker message has no usable id.");
  }
  if (!isString(kind) || !KINDS.has(kind)) {
    reject("A worker message names an unknown operation.");
  }
  if (isString(value.text) && value.text.length > MAX_MESSAGE_BYTES) {
    throw new SopsError(
      "resource_limit",
      "A worker message exceeds its size budget.",
    );
  }
  // SAFETY: `KINDS` and `REQUESTS` carry the same keys, and `Object.hasOwn`
  // has just shown this one is present, so the index is a known key.
  const build: RequestBuilder | undefined = Object.hasOwn(REQUESTS, kind)
    ? REQUESTS[overlapCast<string, keyof typeof REQUESTS>(kind)]
    : undefined;
  if (!build) reject("A worker message names an unknown operation.");
  return build(id, value);
}

const RESPONSES = {
  inspect(id, value) {
    if (!isJsonObject(value.inspection)) reject("A worker reply is malformed.");
    // SAFETY: the inspection is produced by this engine inside the worker.
    const inspection: Inspection = overlapCast(value.inspection);
    return { id, ok: true, kind: "inspect", inspection };
  },
  open(id, value) {
    if (!isString(value.handle) || !isString(value.plaintext)) {
      reject("A worker reply is malformed.");
    }
    if (!isJsonObject(value.inspection) || !isJsonObject(value.report)) {
      reject("A worker reply is malformed.");
    }
    // SAFETY: both are produced by this engine inside the worker.
    const inspection: Inspection = overlapCast(value.inspection);
    const report: RecoveryReport = overlapCast(value.report);
    return {
      id,
      ok: true,
      kind: "open",
      handle: value.handle,
      plaintext: value.plaintext,
      inspection,
      report,
    };
  },
  output(id, value) {
    if (!isString(value.output)) reject("A worker reply is malformed.");
    return { id, ok: true, kind: "output", output: value.output };
  },
  done(id: string) {
    return { id, ok: true, kind: "done" };
  },
} satisfies Record<string, ResponseBuilder>;

/** Validate a response on the page side before it reaches the UI. */
export function parseResponse(value: BoundaryValue): SopsResponse {
  if (!isJsonObject(value) || !isString(value.id)) {
    reject("A worker reply is malformed.");
  }
  if (value.ok === false) {
    if (!isString(value.code) || !isString(value.message)) {
      reject("A worker reply is malformed.");
    }
    // SAFETY: the worker only ever sends its own SopsErrorCode values, and
    // an unrecognized one would only mis-label an already-failed operation.
    const code: SopsError["code"] = overlapCast(value.code);
    return { id: value.id, ok: false, code, message: value.message };
  }
  if (value.ok !== true || !isString(value.kind)) {
    reject("A worker reply is malformed.");
  }
  const kind = value.kind;
  // SAFETY: `Object.hasOwn` has just shown this is one of `RESPONSES`' keys.
  const build: ResponseBuilder | undefined = Object.hasOwn(RESPONSES, kind)
    ? RESPONSES[overlapCast<string, keyof typeof RESPONSES>(kind)]
    : undefined;
  if (!build) reject("A worker reply names an unknown result.");
  return build(value.id, value);
}
