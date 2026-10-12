/** Real native AES and original vault-core wire compatibility; no fake signer/receiver or platform claim. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import {
  importVaultKey,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { expect, it } from "vitest";
import {
  ControlledCanaryCommandSchema,
  encodeControlledCanaryCommand,
} from "./controlled-receiver-contract.js";
import {
  canaryLogicalPath,
  indexedCanaryBlob,
  nextCanaryIndexData,
  readCanaryIndexData,
} from "./indexed-record-data.js";
import { captureIndexedCanarySlotCustodyData } from "./indexed-slot-custody-data.js";
import {
  type Fixture,
  awaitEntered,
  closeSeal,
  gate,
  heldNativeDecrypt,
  keyOf,
  observe,
  observeCall,
  originalSeal,
  owned,
  rejected,
  verifyAll,
} from "./original-indexed-leaf.test-support.js";
import {
  controlledCanaryAudience,
  copyCanaryReceiverProfile,
} from "./receiver-profile-data.js";
const service = "a".repeat(64);
const logical = canaryLogicalPath(service);
const binding = vaultSealBinding("owned", "index");
async function aesAndIndex(f: Fixture) {
  const seal = originalSeal(f);
  const key = keyOf(f);
  const before = { v: 1, files: { "config/public": 2 } };
  const original = await sealJson(key, before, binding);
  expect(await seal.open(key, original, binding)).toEqual(before);
  const wire = JSON.stringify(await seal.seal(key, before, binding));
  expect(
    await openJson(key, indexedCanaryBlob(wire, 2 << 20), binding),
  ).toEqual(before);
  const captured = await readCanaryIndexData(
    "owned",
    wire,
    key,
    seal,
    () => {},
  );
  const next = await nextCanaryIndexData(
    "owned",
    captured,
    logical,
    key,
    seal,
    () => {},
  );
  const decoded: BoundaryValue = await openJson(
    key,
    indexedCanaryBlob(next, 2 << 20),
    binding,
  );
  if (!isJsonObject(decoded) || !isJsonObject(decoded.files))
    throw new Error("Actual index missing.");
  expect(decoded.files[logical]).toBe(1);
  expect(decoded.files["config/public"]).toBe(2);
  const wrongTomb = observe(
    f,
    readCanaryIndexData("foreign", wire, key, seal, () => {}),
  );
  await rejected(wrongTomb);
  const other = await importVaultKey(new Uint8Array(32));
  await rejected(observe(f, seal.open(other, original, binding)));
  const unsafe = await sealJson(
    key,
    { v: 1, files: { "../escape": 1 } },
    binding,
  );
  const unsafeRead = observe(
    f,
    readCanaryIndexData("owned", JSON.stringify(unsafe), key, seal, () => {}),
  );
  await rejected(unsafeRead);
  const invalid = await sealJson(
    key,
    { v: 1, files: { "config/overflow": Number.MAX_SAFE_INTEGER } },
    binding,
  );
  await rejected(
    observe(
      f,
      readCanaryIndexData(
        "owned",
        JSON.stringify(invalid),
        key,
        seal,
        () => {},
      ),
    ),
  );
  const tooMany: Record<string, number> = {};
  for (let i = 0; i < 129; ++i) tooMany[`config/item-${i}`] = 1;
  const oversized = await sealJson(key, { v: 1, files: tooMany }, binding);
  await rejected(
    observe(
      f,
      readCanaryIndexData(
        "owned",
        JSON.stringify(oversized),
        key,
        seal,
        () => {},
      ),
    ),
  );
  expect(() =>
    indexedCanaryBlob('{"ivB64":"a","ivB64":"b","ctB64":"c"}', 4096),
  ).toThrow();
  verifyAll(f);
}
it("opens original AES wire in both directions and preserves public revisions while refusing foreign bindings and unsafe indexes", () =>
  owned(aesAndIndex));
async function heldCryptoRetirement(f: Fixture) {
  const key = keyOf(f);
  const original = await sealJson(
    key,
    { controlled: "synthetic canary fixture" },
    binding,
  );
  const held = heldNativeDecrypt(f);
  const seal = originalSeal(f);
  const opening = observe(f, seal.open(key, original, binding));
  await awaitEntered(held.entered.promise, opening);
  held.spy.mockRestore();
  const originalCheck = await rejected(observeCall(f, seal.check));
  if (!(originalCheck.cause instanceof Error))
    throw new Error("Original provider refusal missing.");
  expect(originalCheck.cause.message).toMatch(/retired/);
  const closed = closeSeal(f);
  expect(closed.promise).toBe(seal.close());
  await Promise.resolve();
  expect(closed.settled).toBe(false);
  held.held.release();
  const refused = await rejected(opening);
  const drain = await rejected(closed);
  if (!(drain.cause instanceof AggregateError))
    throw new Error("Native drain failures missing.");
  expect(
    drain.cause.errors.some((cause) => Object.is(cause, refused.cause)),
  ).toBe(true);
  expect(f.bytes).toHaveLength(1);
  for (const bytes of f.bytes)
    expect([...bytes]).toEqual(new Array(bytes.length).fill(0));
  verifyAll(f);
}
it("original native decrypt drains before close after provider drift and wipes its late genuine plaintext", () =>
  owned(heldCryptoRetirement));
async function acceptedIndexRefusal<T>(f: Fixture, cause: T) {
  const wire = JSON.stringify(
    await sealJson(keyOf(f), { v: 1, files: {} }, binding),
  );
  const entered = gate();
  const held = gate();
  f.deliveries.push(entered, held);
  f.custody = captureIndexedCanarySlotCustodyData({
    read: async () => wire,
    publish: async (expected, next) => {
      expect(expected).toBe(wire);
      expect(
        await openJson(keyOf(f), indexedCanaryBlob(next, 2 << 20), binding),
      ).toEqual({ v: 1, files: { [logical]: 1 } });
      if (!f.custody) throw new Error("Actual indexed owner missing.");
      f.custodyDrain = observe(f, f.custody.drain());
      entered.release();
      await held.promise;
      throw cause;
    },
  });
  const next = JSON.stringify(
    await sealJson(keyOf(f), { v: 1, files: { [logical]: 1 } }, binding),
  );
  const published = observe(f, f.custody.slot.publish(wire, next));
  await awaitEntered(entered.promise, published);
  const drained = f.custodyDrain;
  if (!drained) throw new Error("Reentrant accepted-index drain missing.");
  expect(drained.promise).toBe(f.custody.drain());
  const custody = f.custody;
  const ended = await rejected(observeCall(f, () => custody.slot.read()));
  if (!(ended.cause instanceof Error))
    throw new Error("Original admission refusal missing.");
  expect(ended.cause.message).toMatch(/ended/);
  expect(drained.settled).toBe(false);
  held.release();
  const refusal = await rejected(published);
  const drain = await rejected(drained);
  expect(Object.is(refusal.cause, cause)).toBe(true);
  if (!(drain.cause instanceof AggregateError))
    throw new Error("Original index cause missing.");
  expect(drain.cause.errors).toHaveLength(1);
  expect(Object.is(drain.cause.errors[0], cause)).toBe(true);
  verifyAll(f);
}
const nativeRefusals = [
  { label: "undefined", cause: undefined },
  {
    label: "opaque Promise",
    cause: Promise.resolve("original indexed refusal"),
  },
  { label: "signed zero", cause: -0 },
];
it.each(nativeRefusals)(
  "reentrant accepted encrypted-index publication retains $label after its genuine work drains",
  ({ cause }) => owned((f) => acceptedIndexRefusal(f, cause)),
);
async function boundedAcceptedIndex(f: Fixture) {
  const wire = JSON.stringify(
    await sealJson(keyOf(f), { v: 1, files: {} }, binding),
  );
  let actualReads = 0;
  f.custody = captureIndexedCanarySlotCustodyData({
    read: async () => {
      ++actualReads;
      return wire;
    },
    publish: async () => {
      throw new Error("Read control must not publish.");
    },
  });
  const custody = f.custody;
  const reads: Promise<string | null>[] = [];
  for (let i = 0; i < 512; ++i) reads.push(custody.slot.read());
  const extra = observeCall(f, () => custody.slot.read());
  const all = observe(f, Promise.all(reads));
  const ended = await rejected(extra);
  if (!(ended.cause instanceof Error))
    throw new Error("Original call bound refusal missing.");
  expect(ended.cause.message).toMatch(/ended/);
  const result = await all.outcome;
  if (result.kind !== "fulfilled")
    throw new Error("Accepted original reads failed.");
  expect(result.value).toHaveLength(512);
  expect(new Set(result.value)).toEqual(new Set([wire]));
  expect(actualReads).toBe(512);
  f.custodyDrain = observe(f, f.custody.drain());
  expect((await f.custodyDrain.outcome).kind).toBe("fulfilled");
  verifyAll(f);
}
it("bounds accepted indexed delivery work before calling the original callback a 513th time", () =>
  owned(boundedAcceptedIndex));
it("keeps controlled receiver destinations and signed-command data bounded without production authority", () => {
  const profile = copyCanaryReceiverProfile({
    endpoint: "http://127.0.0.1:9123",
    bindPort: 9123,
    browserOrigin: "https://owner.example",
    serviceId: service,
  });
  expect(Object.isFrozen(profile)).toBe(true);
  expect(controlledCanaryAudience(profile, service)).toBe(
    `${profile.endpoint}/v1/agent-canaries/execute#${service}/${service}`,
  );
  for (const endpoint of [
    "http://127.0.0.1:9124",
    "http://remote.example:9123",
    "https://owner.example/path",
    "https://user:password@owner.example",
  ])
    expect(() => copyCanaryReceiverProfile({ ...profile, endpoint })).toThrow();
  const command = {
    kind: "enroll" as const,
    contextId: service,
    label: "Controlled",
    artifactKind: "mcp-config" as const,
    retentionDays: 90,
  };
  expect(encodeControlledCanaryCommand(command)).toBe(
    JSON.stringify(["enroll", service, "Controlled", "mcp-config", 90]),
  );
  expect(() =>
    ControlledCanaryCommandSchema.parse({ ...command, retentionDays: 91 }),
  ).toThrow();
  expect(() =>
    ControlledCanaryCommandSchema.parse({ ...command, owner: true }),
  ).toThrow();
});
