/**
 * The page ↔ worker message vocabulary (ownership.md §4.7, PWA-09).
 *
 * The page may ask two things: who the worker is (`WORKER_HELLO`) and which
 * approved modules to keep offline (`PLAN_ASSETS`, module ids only). The
 * worker answers with its identity, and with one of three plan outcomes.
 * Every other message type is ignored, and a `PLAN_ASSETS` that carries
 * anything but the four known fields — a URL list under any name, an extra
 * key, an id that is not a module id — is refused whole.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type WorkerHelloMessage = Readonly<{ type: "WORKER_HELLO" }>;

export type PlanAssetsMessage = Readonly<{
  type: "PLAN_ASSETS";
  releaseId: string;
  planDigest: string;
  moduleIds: readonly string[];
}>;

export type WorkerInfoMessage = Readonly<{
  type: "WORKER_INFO";
  releaseId: string;
  variant: string;
  scopePath: string;
}>;

export type OfflineReadyMessage = Readonly<{
  type: "OFFLINE_READY";
  releaseId: string;
  planDigest: string;
}>;

export type OfflinePartialMessage = Readonly<{
  type: "OFFLINE_PARTIAL";
  releaseId: string;
  planDigest: string;
  missing: number;
}>;

export type OfflineStorageUnavailableMessage = Readonly<{
  type: "OFFLINE_STORAGE_UNAVAILABLE";
  releaseId: string;
  planDigest: string;
}>;

export type PlanRejectReason =
  | "malformed"
  | "carries-url"
  | "release-mismatch"
  | "unknown-module"
  | "graph-unavailable";

export type PlanRejectedMessage = Readonly<{
  type: "PLAN_REJECTED";
  reason: PlanRejectReason;
}>;

export type WorkerToPageMessage =
  | WorkerInfoMessage
  | OfflineReadyMessage
  | OfflinePartialMessage
  | OfflineStorageUnavailableMessage
  | PlanRejectedMessage;

export type PlanAssetsParse =
  | Readonly<{ ok: true; message: PlanAssetsMessage }>
  | Readonly<{ ok: false; reason: "malformed" | "carries-url" }>;

const PLAN_KEYS = ["type", "releaseId", "planDigest", "moduleIds"] as const;
const RELEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLAN_DIGEST = /^[A-Za-z0-9:_-]{1,160}$/;
/**
 * `<capability-id>/<unit>` — the module-id grammar of
 * `@opensesame/capability-composition` (`ids.ts`), restated as one pattern so
 * the worker bundle carries no resolver. A slash is the only separator; a
 * scheme, a query, a fragment, a dot segment or a file extension cannot pass.
 */
const MODULE_ID =
  /^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+\/[a-z][a-z0-9-]*$/;

/** Whether a rejected id looks like it was trying to be a location. */
function looksLikeUrl(value: string): boolean {
  return (
    value.includes(":") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.startsWith(".") ||
    value.includes("?") ||
    value.includes("#") ||
    /\.(m?js|css|json|html|wasm)$/i.test(value)
  );
}

export function isWorkerHello(data: BoundaryValue): boolean {
  return isJsonObject(data) && data.type === "WORKER_HELLO";
}

/** Strict parse of a `PLAN_ASSETS` request; anything off-grammar is refused. */
export function parsePlanAssets(data: BoundaryValue): PlanAssetsParse {
  if (!isJsonObject(data) || data.type !== "PLAN_ASSETS")
    return { ok: false, reason: "malformed" };
  const keys = Object.keys(data);
  if (keys.length !== PLAN_KEYS.length || !PLAN_KEYS.every((k) => k in data))
    return { ok: false, reason: "malformed" };
  const { releaseId, planDigest, moduleIds } = data;
  if (!isString(releaseId) || !RELEASE_ID.test(releaseId))
    return { ok: false, reason: "malformed" };
  if (!isString(planDigest) || !PLAN_DIGEST.test(planDigest))
    return { ok: false, reason: "malformed" };
  if (!Array.isArray(moduleIds) || moduleIds.length > 512)
    return { ok: false, reason: "malformed" };
  const ids: string[] = [];
  for (const id of moduleIds) {
    if (!isString(id)) return { ok: false, reason: "malformed" };
    if (!MODULE_ID.test(id) || id.length > 129)
      return {
        ok: false,
        reason: looksLikeUrl(id) ? "carries-url" : "malformed",
      };
    ids.push(id);
  }
  return {
    ok: true,
    message: {
      type: "PLAN_ASSETS",
      releaseId,
      planDigest,
      moduleIds: [...new Set(ids)].sort(),
    },
  };
}
