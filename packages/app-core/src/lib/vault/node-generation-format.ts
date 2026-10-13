/** Atomic Node generation ciphertext data only. Physical origin metadata is never an owner or REAL grant. */
import { z } from "zod";
import {
  AT_REST_PREFIX,
  atRestBinding,
  openAtRest,
  sealAtRest,
} from "../at-rest/cipher.js";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import {
  NODE_PROJECTION_WIRE_LIMIT,
  decodeAuthenticationProjection,
} from "../secret-fs/authentication-projection.js";
import type { AuthenticationCiphertext } from "./authentication-storage.js";
import {
  type NodeAuxiliarySnapshot,
  copyNodeAuxiliarySnapshot,
  nodeAuxiliarySnapshotSchema,
} from "./node-auxiliary-generation-data.js";
import {
  type NodePhysicalRetirement,
  copyNodePhysicalRetirement,
  nodePhysicalRetirementSchema,
} from "./node-physical-retirement-data.js";
export const NODE_GENERATION_FILE = "opensesame-generation.v1.json";
export const NODE_GENERATION_PLAIN_LIMIT = 10 * 1024 * 1024;
export const NODE_GENERATION_WIRE_LIMIT = 14 * 1024 * 1024;
const tombName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u);
const physicalIdentity = z.string().regex(/^[0-9]{1,32}:[0-9]{1,32}$/u);
const base = {
  version: z.literal(1),
  tomb: tombName,
  physicalIdentity,
  sequence: z.number().int().positive().safe(),
};
const snapshot = z.strictObject({
  tomb: tombName,
  header: z.string(),
  body: z.string(),
});
const schema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...base,
    mode: z.literal("active"),
    snapshot,
    auxiliary: nodeAuxiliarySnapshotSchema.optional(),
    retirement: nodePhysicalRetirementSchema.optional(),
  }),
  z.strictObject({ ...base, mode: z.literal("deleted") }),
]);
export type NodeGeneration = z.infer<typeof schema>;
export type GenerationChange =
  | Readonly<{
      mode: "active";
      snapshot: AuthenticationCiphertext;
      auxiliary?: NodeAuxiliarySnapshot;
      retirement?: NodePhysicalRetirement;
    }>
  | Readonly<{ mode: "deleted" }>;
function unavailable(): never {
  throw new Error("Original Node generation is unavailable.");
}
function binding(tomb: string, identity: string) {
  tombName.parse(tomb);
  physicalIdentity.parse(identity);
  return atRestBinding(
    "node-vault-generation-v1",
    JSON.stringify([tomb, identity]),
  );
}
function validateGeneration(
  tomb: string,
  identity: string,
  data: NodeGeneration,
) {
  if (data.tomb !== tomb || data.physicalIdentity !== identity) unavailable();
  if (data.mode === "active") {
    if (data.snapshot.tomb !== tomb) unavailable();
    assertUnambiguousJson(data.snapshot.header, 65536);
    if (
      new TextEncoder().encode(data.snapshot.body).length >
      NODE_PROJECTION_WIRE_LIMIT
    )
      unavailable();
    decodeAuthenticationProjection(tomb, data.snapshot.body);
    Object.freeze(data.snapshot);
    if (data.retirement !== undefined)
      data.retirement = copyNodePhysicalRetirement(data.retirement);
    if (data.auxiliary !== undefined) {
      const auxiliary = copyNodeAuxiliarySnapshot(tomb, data.auxiliary);
      if (JSON.stringify(auxiliary) !== JSON.stringify(data.auxiliary))
        unavailable();
      data.auxiliary = auxiliary;
    }
  }
  return Object.freeze(data);
}
/** Caller-owned change is copied and strictly bounded before any physical IO. */
export function prepareNodeGeneration(
  tomb: string,
  identity: string,
  sequence: number,
  change: GenerationChange,
): NodeGeneration {
  const data =
    change.mode === "active"
      ? {
          version: 1,
          tomb,
          physicalIdentity: identity,
          sequence,
          mode: change.mode,
          retirement:
            change.retirement === undefined
              ? undefined
              : copyNodePhysicalRetirement(change.retirement),
          auxiliary:
            change.auxiliary === undefined
              ? undefined
              : copyNodeAuxiliarySnapshot(tomb, change.auxiliary),
          snapshot: {
            tomb: change.snapshot.tomb,
            header: change.snapshot.header,
            body: change.snapshot.body,
          },
        }
      : {
          version: 1,
          tomb,
          physicalIdentity: identity,
          sequence,
          mode: change.mode,
        };
  const copied = schema.parse(data);
  return validateGeneration(tomb, identity, copied);
}
export function sealNodeGeneration(
  key: Uint8Array,
  tomb: string,
  identity: string,
  data: NodeGeneration,
): Uint8Array {
  const copied = validateGeneration(tomb, identity, schema.parse(data));
  const wire = JSON.stringify(copied);
  assertUnambiguousJson(wire, NODE_GENERATION_PLAIN_LIMIT);
  const sealed = new TextEncoder().encode(
    sealAtRest(key, binding(tomb, identity), wire),
  );
  if (sealed.length > NODE_GENERATION_WIRE_LIMIT) unavailable();
  return sealed;
}
/** Authenticates the at-rest record and exact original directory/tomb binding; output is ciphertext data, never authority. */
export function openNodeGeneration(
  key: Uint8Array,
  tomb: string,
  identity: string,
  bytes: Uint8Array,
): NodeGeneration {
  if (bytes.length > NODE_GENERATION_WIRE_LIMIT) unavailable();
  const sealed = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!sealed.startsWith(AT_REST_PREFIX)) unavailable();
  const wire = openAtRest(key, binding(tomb, identity), sealed);
  if (wire === null) unavailable();
  assertUnambiguousJson(wire, NODE_GENERATION_PLAIN_LIMIT);
  const data = schema.parse(JSON.parse(wire));
  if (JSON.stringify(data) !== wire) unavailable();
  return validateGeneration(tomb, identity, data);
}
