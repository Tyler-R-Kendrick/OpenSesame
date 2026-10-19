/** Sealed paired detection credentials. These keys cannot sign vault authorization. */
import { isJsonObject } from "@opensesame/os-domain";
import { vaultSealBinding } from "@opensesame/vault-core";
import { z } from "zod";
import type { RetiredOwnerAuthenticatedData } from "../vault/retired-owner-operation.js";
import {
  ControlledCanaryHex,
  ControlledCanaryRecordSchema,
} from "./controlled-receiver-contract.js";
import {
  CANARY_RECORD_LIMIT,
  canaryLogicalPath,
  indexedCanaryBlob,
} from "./indexed-record-data.js";
import type { CanaryIndexedSealData } from "./original-indexed-seal-data.js";
import type { CanaryReceiverProfile } from "./receiver-profile-data.js";
const publicSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().length(43),
  y: z.string().length(43),
});
const schema = z.strictObject({
  v: z.literal(1),
  root: z.string().regex(/^root:[0-9a-f]{64}$/u),
  context: z.string().max(32768),
  endpoint: z.string(),
  origin: z.string(),
  keyId: ControlledCanaryHex,
  publicJwk: publicSchema,
  privateJwk: z.strictObject({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().length(43),
    y: z.string().length(43),
    d: z.string().length(43),
  }),
  records: z
    .array(
      z.strictObject({
        record: ControlledCanaryRecordSchema,
        token: ControlledCanaryHex,
      }),
    )
    .max(128),
});
export type CanaryOwnerCustody = z.infer<typeof schema>;
export async function canaryDigest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function mint(
  data: RetiredOwnerAuthenticatedData,
  profile: CanaryReceiverProfile,
): Promise<CanaryOwnerCustody> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  data.check();
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  data.check();
  const publicJwk = publicSchema.parse({
    kty: pub.kty,
    crv: pub.crv,
    x: pub.x,
    y: pub.y,
  });
  return schema.parse({
    v: 1,
    root: data.rootCommitment,
    context: data.contextWire,
    endpoint: profile.endpoint,
    origin: profile.browserOrigin,
    keyId: await canaryDigest(JSON.stringify(publicJwk)),
    publicJwk,
    privateJwk: { ...publicJwk, d: priv.d },
    records: [],
  });
}
export async function openCanaryOwnerCustody(
  data: RetiredOwnerAuthenticatedData,
  profile: CanaryReceiverProfile,
  seal: CanaryIndexedSealData,
  allowMint: boolean,
) {
  const key = canaryLogicalPath(profile.serviceId);
  const binding = vaultSealBinding(
    data.snapshot.tomb,
    `controlled-canary:${profile.serviceId}`,
  );
  const before = await data.readers.device.read(key, CANARY_RECORD_LIMIT);
  data.check();
  if (before === null && !allowMint)
    throw new Error("Pair this receiver before managing canaries.");
  const held =
    before === null
      ? await mint(data, profile)
      : schema.parse(
          await seal.open(
            data.key,
            indexedCanaryBlob(before, CANARY_RECORD_LIMIT),
            binding,
          ),
        );
  data.check();
  if (
    held.root !== data.rootCommitment ||
    held.context !== data.contextWire ||
    held.endpoint !== profile.endpoint ||
    held.origin !== profile.browserOrigin ||
    held.keyId !== (await canaryDigest(JSON.stringify(held.publicJwk)))
  )
    throw new Error("Canary signing custody differs from this owner context.");
  if (
    held.privateJwk.x !== held.publicJwk.x ||
    held.privateJwk.y !== held.publicJwk.y
  )
    throw new Error("Canary signing key differs.");
  return {
    held,
    async publish(next: CanaryOwnerCustody) {
      data.check();
      const value = JSON.stringify(
        await seal.seal(data.key, schema.parse(next), binding),
      );
      data.check();
      if (!isJsonObject(JSON.parse(value)))
        throw new Error("Invalid canary seal.");
      await data.readers.device.publish(
        key,
        before,
        value,
        CANARY_RECORD_LIMIT,
        data.check,
      );
      data.check();
      if ((await data.readers.device.read(key, CANARY_RECORD_LIMIT)) !== value)
        throw new Error("Canary custody publication changed.");
      data.check();
    },
  };
}
