/** Exact original Node ciphertext decoding only. Root proof remains inside the owning Store. */
import { createHash } from "node:crypto";
import { host } from "@opensesame/app-core/host.js";
import {
  atRestBinding,
  openAtRest,
  sealAtRest,
} from "@opensesame/app-core/lib/at-rest/cipher.js";
import { encodeAuthenticationProjection } from "@opensesame/app-core/lib/secret-fs/authentication-projection.js";
import { openNodeGeneration } from "@opensesame/app-core/lib/vault/node-generation-format.js";
import type {
  NativeDataProcess,
  NativeDataReply,
} from "./native-data-process.js";
export function unavailable(): never {
  throw new Error("Original native vault DATA is unavailable.");
}
export async function key() {
  const keys = host().atRestKeys;
  if (!keys) unavailable();
  return await keys.load();
}
export function bytes(reply: NativeDataReply): Uint8Array | null {
  if (reply.kind !== "bytes") unavailable();
  if (reply.base64 === null) return null;
  const value = Buffer.from(reply.base64, "base64");
  if (value.toString("base64") !== reply.base64) unavailable();
  return value;
}
export async function identity(
  process: NativeDataProcess,
  scope?: "vault" | "origin",
) {
  const value = await process.request(
    scope ? { kind: "identity", scope } : { kind: "state_identity" },
  );
  if (value.kind !== "identity") unavailable();
  return value.value;
}
export async function snapshot(process: NativeDataProcess, tomb: string) {
  const reply = await process.request({ kind: "read_projection" });
  if (reply.kind === "absent")
    return {
      marker: null,
      physicalIdentity: await identity(process),
      deleted: false as const,
      snapshot: { tomb, header: null, body: null },
    };

  const marker = bytes(await process.request({ kind: "read_generation" }));
  const physicalIdentity = await identity(process, "vault");
  if (marker !== null) {
    const generation = openNodeGeneration(
      await key(),
      tomb,
      physicalIdentity,
      marker,
    );
    if (generation.mode !== "active")
      return {
        marker,
        physicalIdentity,
        deleted: true as const,
        snapshot: null,
      };
    return {
      marker,
      physicalIdentity,
      deleted: false as const,
      snapshot: generation.snapshot,
    };
  }
  if (reply.kind !== "projection") unavailable();
  let header: string | null = null;
  const records = [];
  for (const row of reply.records) {
    const wire = Buffer.from(row[1], "base64");
    if (wire.toString("base64") !== row[1]) unavailable();
    if (row[0] === "header.json")
      header = new TextDecoder("utf-8", { fatal: true }).decode(wire);
    else records.push({ path: row[0], bytes: wire });
  }
  return {
    marker,
    physicalIdentity,
    deleted: false as const,
    snapshot: {
      tomb,
      header,
      body:
        records.length === 0
          ? null
          : encodeAuthenticationProjection(tomb, records),
    },
  };
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function deviceName(logical: string) {
  const parts = logical.split("/");
  const scope = parts[0] === "tomb" ? `tomb/${parts[1]}` : "global";
  return `opensesame-pages-node-record-v2-${digest(scope)}-${digest(logical)}.json`;
}
function binding(logical: string) {
  return atRestBinding(
    "node-device-record-v1",
    JSON.stringify([logical, deviceName(logical)]),
  );
}
export async function readDevice(
  process: NativeDataProcess,
  logical: string,
  maximum: number,
) {
  const ciphertext = bytes(
    await process.request({ kind: "read_device", logical_key: logical }),
  );
  if (ciphertext === null) return { value: null, ciphertext };
  const value = openAtRest(
    await key(),
    binding(logical),
    new TextDecoder("utf-8", { fatal: true }).decode(ciphertext),
  );
  if (value === null || Buffer.byteLength(value) > maximum) unavailable();
  return { value, ciphertext };
}
export async function publishDevice(
  process: NativeDataProcess,
  logical: string,
  expected: string | null,
  next: string,
  maximum: number,
  check: () => void,
) {
  if (Buffer.byteLength(next) > maximum) unavailable();
  const before = await readDevice(process, logical, maximum);
  if (before.value !== expected) unavailable();
  const ciphertext = sealAtRest(await key(), binding(logical), next);
  check();
  await process.request({
    kind: "publish_device",
    logical_key: logical,
    expected:
      before.ciphertext === null
        ? null
        : Buffer.from(before.ciphertext).toString("base64"),
    next: Buffer.from(ciphertext).toString("base64"),
  });
  check();
}
