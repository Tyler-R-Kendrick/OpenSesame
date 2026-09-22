/**
 * Strict parsers for the two documents a runtime produces rather than a
 * person: the consent receipt (written at acceptance) and the distribution
 * contract (emitted by the build). Both are digest- or id-bound and reject
 * anything the loader could not act on.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { DIGEST_RE, receiptDigest } from "./canonical.js";
import {
  type Diagnostic,
  type ParseResult,
  parseFailure,
  parseResultOf,
} from "./diagnostics.js";
import {
  MAX_ID_LENGTH,
  MAX_MODULE_ID_LENGTH,
  isCapabilityId,
  isModuleId,
} from "./ids.js";
import {
  type ObjectReader,
  REVISION_BOUNDS,
  indexPath,
  rootReader,
} from "./parse-fields.js";
import type {
  ConsentReceipt,
  DistributionContract,
  WorkerVariant,
} from "./types.js";

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_WORKER_VARIANTS = 16;
const MAX_SATISFIES = 16;
const MAX_MODULE_IDS = 1024;
const MAX_PATH_LENGTH = 256;
const DIGEST_BOUNDS = { min: 71, max: 71, pattern: DIGEST_RE, code: "INVALID_DIGEST" } as const;

export function parseConsentReceipt(v: BoundaryValue): ParseResult<ConsentReceipt> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseFailure(diags);
  const schemaVersion = reader.literal("schemaVersion", 1);
  const instanceId = reader.opaqueId("instanceId");
  const installationId = reader.opaqueId("installationId");
  const policyRevision = reader.string("policyRevision", REVISION_BOUNDS);
  const selectionRevision = reader.string("selectionRevision", REVISION_BOUNDS);
  const acceptedAt = reader.string("acceptedAt", { min: 20, max: 35, pattern: ISO_INSTANT_RE });
  const roots = reader.idList("roots");
  const exposure = reader.record(
    "exposure",
    isCapabilityId,
    "exposure key is not a capability id",
    (digest) => DIGEST_RE.test(digest),
    "exposure digest must be sha256:<64 hex>",
  );
  const storedDigest = reader.string("receiptDigest", DIGEST_BOUNDS);
  reader.finish();
  if (
    schemaVersion === undefined ||
    instanceId === undefined ||
    installationId === undefined ||
    policyRevision === undefined ||
    selectionRevision === undefined ||
    acceptedAt === undefined ||
    roots === undefined ||
    exposure === undefined ||
    storedDigest === undefined
  ) {
    return parseFailure(diags);
  }
  if (Number.isNaN(Date.parse(acceptedAt))) {
    reader.report("INVALID_VALUE", "acceptedAt", "`acceptedAt` is not an ISO 8601 instant");
  }
  roots.forEach((root, index) => {
    if (exposure[root] === undefined) {
      reader.report("INVALID_VALUE", indexPath("roots", index), `root \`${root}\` has no exposure digest`);
    }
  });
  const body = {
    schemaVersion,
    instanceId,
    installationId,
    policyRevision,
    selectionRevision,
    acceptedAt,
    roots,
    exposure,
  };
  if (receiptDigest(body) !== storedDigest) {
    reader.report("INVALID_DIGEST", "receiptDigest", "`receiptDigest` does not match the receipt body");
  }
  return parseResultOf(diags, { ...body, receiptDigest: storedDigest });
}

const UNIT_BOUNDS = {
  min: 1,
  max: MAX_ID_LENGTH,
  pattern: /^[a-z][a-z0-9-]*$/,
  code: "INVALID_ID",
} as const;
const SCRIPT_PATH_BOUNDS = {
  min: 1,
  max: MAX_PATH_LENGTH,
  // Same-origin and base-relative: no scheme, no leading slash, ends in .js.
  pattern: /^(?![a-z]+:)(?!\/)\S+\.js$/i,
} as const;

function readWorkerVariant(reader: ObjectReader): WorkerVariant | undefined {
  const id = reader.string("id", UNIT_BOUNDS);
  const scriptPath = reader.string("scriptPath", SCRIPT_PATH_BOUNDS);
  const satisfies = reader.stringList("satisfies", UNIT_BOUNDS);
  reader.finish();
  if (id === undefined || scriptPath === undefined || satisfies === undefined) {
    return undefined;
  }
  if (satisfies.length > MAX_SATISFIES) {
    reader.report("TOO_MANY_ITEMS", `${reader.path}.satisfies`, `\`satisfies\` exceeds ${MAX_SATISFIES} entries`);
    return undefined;
  }
  return { id, scriptPath, satisfies };
}

function readWorkerVariants(reader: ObjectReader): WorkerVariant[] | undefined {
  const readers = reader.objectList("workerVariants", MAX_WORKER_VARIANTS);
  if (readers === undefined) return undefined;
  const out: WorkerVariant[] = [];
  let valid = true;
  for (const entry of readers) {
    const variant = readWorkerVariant(entry);
    if (variant === undefined) {
      valid = false;
      continue;
    }
    if (out.some((v) => v.id === variant.id)) {
      reader.report("DUPLICATE_ID", `${entry.path}.id`, `worker variant \`${variant.id}\` repeats`);
      valid = false;
      continue;
    }
    out.push(variant);
  }
  return valid ? out : undefined;
}

export function parseDistributionContract(
  v: BoundaryValue,
): ParseResult<DistributionContract> {
  const diags: Diagnostic[] = [];
  const reader = rootReader(v, diags);
  if (reader === undefined) return parseFailure(diags);
  const distributionId = reader.opaqueId("distributionId");
  const mode = reader.enumOf("mode", ["selective", "hardened"]);
  const capabilityIds = reader.idList("capabilityIds");
  const moduleIds = reader.stringList(
    "moduleIds",
    { min: 3, max: MAX_MODULE_ID_LENGTH, code: "INVALID_ID" },
    MAX_MODULE_IDS,
  );
  const workerVariants = readWorkerVariants(reader);
  const basePath = reader.string("basePath", {
    min: 1,
    max: MAX_PATH_LENGTH,
    pattern: /^\/(\S*\/)?$/,
  });
  reader.finish();
  if (
    distributionId === undefined ||
    mode === undefined ||
    capabilityIds === undefined ||
    moduleIds === undefined ||
    workerVariants === undefined ||
    basePath === undefined
  ) {
    return parseFailure(diags);
  }
  moduleIds.forEach((moduleId, index) => {
    if (!isModuleId(moduleId)) {
      reader.report("INVALID_ID", indexPath("moduleIds", index), "entry is not a module id");
    }
  });
  return parseResultOf(diags, {
    distributionId,
    mode,
    capabilityIds,
    moduleIds,
    workerVariants,
    basePath,
  });
}
