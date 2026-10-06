import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import {
  installOpfs,
  makeOpfs,
} from "../duress/wipe/fake-opfs.test-support.js";
import {
  kvFileName,
  kvFlush,
  kvForgetFiles,
  kvGet,
  kvRefresh,
  kvSetDurable,
} from "../kv.js";
import { appendObservation } from "./queue.js";
import {
  configureObservationReceiver,
  getObservationReceiverStatus,
} from "./receiver.js";
import {
  MAX_OUTBOX_BYTES,
  outboxKey,
  readObservationOutbox,
  readReceiverConfig,
  receiverKey,
  withObservationLock,
  writeObservationOutbox,
} from "./storage.js";
import { fixture, metadata, owner, provision } from "./test-support.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  configureHost(createTestHost());
});
it("device-seals independent pairing and outbox; refresh restores exact ciphertext only after durable enqueue", async () => {
  const root = makeOpfs();
  installOpfs(root);
  const f = await fixture();
  await configureObservationReceiver({
    ...owner,
    provision: provision(),
    enabled: false,
  });
  const config = await readReceiverConfig("personal");
  if (!config) throw new Error("Missing configured receiver.");
  await withObservationLock("personal", () =>
    appendObservation(config, metadata(f.identity), true),
  );
  await kvFlush();
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    durable: true,
  });
  const original = kvGet(outboxKey("personal"));
  expect(original).toBeTruthy();
  const disk = [...root.files.values()].join("\n");
  expect(disk).not.toContain(config.provision.independentKeyMaterialB64);
  expect(disk).not.toContain("retired_credential_observed");
  expect(disk).not.toContain("ciphertextB64");
  kvForgetFiles(
    new Set([
      kvFileName(receiverKey("personal")),
      kvFileName(outboxKey("personal")),
    ]),
  );
  expect(kvGet(outboxKey("personal"))).toBeNull();
  expect((await readReceiverConfig("personal"))?.provision).toEqual(
    config.provision,
  );
  expect(
    (await readObservationOutbox("personal", f.identity)).entries,
  ).toHaveLength(1);
  expect(kvGet(outboxKey("personal"))).toBe(original);
  const before = root.files.get(kvFileName(outboxKey("personal")));
  const real = root.getFileHandle;
  const fault = vi
    .spyOn(root, "getFileHandle")
    .mockImplementation(async (name, options) => {
      if (name === kvFileName(outboxKey("personal")) && options?.create)
        throw new DOMException("storage unavailable", "InvalidStateError");
      return real(name, options);
    });
  await expect(
    withObservationLock("personal", () =>
      appendObservation(config, metadata(f.identity, "another-subject"), true),
    ),
  ).rejects.toThrow();
  expect(root.files.get(kvFileName(outboxKey("personal")))).toBe(before);
  expect(kvGet(outboxKey("personal"))).toBe(original);
  fault.mockRestore();
  await kvRefresh(outboxKey("personal"), MAX_OUTBOX_BYTES);
  expect(
    (await readObservationOutbox("personal", f.identity)).entries,
  ).toHaveLength(1);
});
it("deduplicates for60seconds and keeps total8/hour budget after records clear/reprovision", async () => {
  const f = await fixture();
  await configureObservationReceiver({
    ...owner,
    provision: provision(),
    enabled: false,
  });
  const config = await readReceiverConfig("personal");
  if (!config) throw new Error("Missing receiver.");
  const initial = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: initial });
  const add = (subject: string) =>
    withObservationLock("personal", () =>
      appendObservation(config, metadata(f.identity, subject), true),
    );
  expect(await add("same")).not.toBeNull();
  expect(await add("same")).toBeNull();
  vi.setSystemTime(initial + 60000);
  expect(await add("same")).not.toBeNull();
  for (let i = 0; i < 6; i++) expect(await add(`unique-${i}`)).not.toBeNull();
  expect(await add("ninth")).toBeNull();
  await configureObservationReceiver({
    ...owner,
    provision: provision(),
    enabled: false,
  });
  const next = await readReceiverConfig("personal");
  if (!next) throw new Error("Missing reconfigured receiver.");
  expect(
    await withObservationLock("personal", () =>
      appendObservation(next, metadata(f.identity, "after-clear"), true),
    ),
  ).toBeNull();
  expect(
    (await readObservationOutbox("personal", f.identity)).history,
  ).toHaveLength(8);
  vi.setSystemTime(initial + 3600001);
  expect(
    await withObservationLock("personal", () =>
      appendObservation(next, metadata(f.identity, "after-hour"), true),
    ),
  ).not.toBeNull();
});
it("fails closed on malformed context, oversized and over-count device records", async () => {
  const f = await fixture();
  const records = await readObservationOutbox("personal", f.identity);
  await kvSetDurable(
    outboxKey("personal"),
    JSON.stringify({ ...records, vaultIdentity: "unrelated-owner" }),
  );
  await expect(readObservationOutbox("personal", f.identity)).rejects.toThrow();
  await kvSetDurable(outboxKey("personal"), `{${" ".repeat(MAX_OUTBOX_BYTES)}`);
  await expect(readObservationOutbox("personal", f.identity)).rejects.toThrow();
  await expect(
    writeObservationOutbox({
      ...records,
      history: Array.from({ length: 9 }, () => ({
        fingerprint: Buffer.alloc(32).toString("base64"),
        at: new Date().toISOString(),
      })),
    }),
  ).rejects.toThrow();
});
it("admits at most32 actual sealed packages and keeps the fixed byte ceiling before writes", async () => {
  const f = await fixture();
  await configureObservationReceiver({
    ...owner,
    provision: provision(),
    enabled: false,
  });
  const config = await readReceiverConfig("personal");
  if (!config) throw new Error("Missing receiver.");
  const start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    for (let i = 0; i < 32; i++) {
      vi.setSystemTime(start + Math.floor(i / 8) * 3600001);
      expect(
        await withObservationLock("personal", () =>
          appendObservation(config, metadata(f.identity, `bounded-${i}`), true),
        ),
      ).not.toBeNull();
    }
    vi.setSystemTime(start + 4 * 3600001);
    expect(
      await withObservationLock("personal", () =>
        appendObservation(config, metadata(f.identity, "thirty-third"), true),
      ),
    ).toBeNull();
    const raw = kvGet(outboxKey("personal"));
    if (!raw) throw new Error("Missing actual sealed queue.");
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(
      MAX_OUTBOX_BYTES,
    );
    expect(
      (await readObservationOutbox("personal", f.identity)).entries,
    ).toHaveLength(32);
  } finally {
    vi.useRealTimers();
  }
});
