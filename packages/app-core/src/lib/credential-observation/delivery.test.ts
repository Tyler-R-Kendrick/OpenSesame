import { expect, it, vi } from "vitest";
import { deliverObservation, flushObservationOutbox } from "./delivery.js";
import { appendObservation } from "./queue.js";
import {
  configureObservationReceiver,
  setObservationReceiverEnabled,
  testObservationReceiver,
} from "./receiver.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "./reference.js";
import {
  readObservationOutbox,
  readReceiverConfig,
  withObservationLock,
} from "./storage.js";
import { fixture, listen, metadata, owner, provision } from "./test-support.js";
it("withdrawal completes while real receiver response is pending and prevents late ACK admission", async () => {
  const f = await fixture();
  let state: ObservationReferenceState | null = null;
  let count = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched!: () => void;
  const seen = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const origin = await listen(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part.toString();
    const ack = await receiver.receive(raw);
    count++;
    if (count === 2) {
      dispatched();
      await held;
    }
    res.end(JSON.stringify(ack));
  });
  const paired = provision(origin);
  const receiver = new ObservationReferenceReceiver(paired, {
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(s) {
      state = structuredClone(s);
    },
  });
  await configureObservationReceiver({
    ...owner,
    provision: paired,
    enabled: false,
  });
  expect(await testObservationReceiver(owner)).toEqual({ delivered: true });
  await setObservationReceiverEnabled({ ...owner, enabled: true });
  const config = await readReceiverConfig("personal");
  if (!config) throw new Error("Missing receiver.");
  const packet = await withObservationLock("personal", () =>
    appendObservation(config, metadata(f.identity), false),
  );
  if (!packet) throw new Error("Missing packet.");
  const delivery = deliverObservation("personal", packet.packageId);
  await seen;
  await setObservationReceiverEnabled({ ...owner, enabled: false });
  expect(
    (await readObservationOutbox("personal", f.identity)).entries,
  ).toHaveLength(0);
  release();
  expect(await delivery).toBe(false);
  expect(await flushObservationOutbox("personal")).toMatchObject({
    delivered: 0,
    queued: 0,
  });
  expect(f.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
  });
});
it("limits retry attempts to5 and drops expired packages instead of reviving production authority", async () => {
  const f = await fixture();
  let hits = 0;
  const origin = await listen((_req, res) => {
    hits++;
    res.writeHead(503).end();
  });
  await configureObservationReceiver({
    ...owner,
    provision: provision(origin),
    enabled: false,
  });
  const config = await readReceiverConfig("personal");
  if (!config) throw new Error("Missing receiver.");
  const start = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    const packet = await withObservationLock("personal", () =>
      appendObservation(config, metadata(f.identity), true),
    );
    if (!packet) throw new Error("Missing packet.");
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(start + i * 5000);
      expect(await deliverObservation("personal", packet.packageId, true)).toBe(
        false,
      );
    }
    vi.setSystemTime(start + 30000);
    expect(await deliverObservation("personal", packet.packageId, true)).toBe(
      false,
    );
    expect(hits).toBe(5);
    expect(
      (await readObservationOutbox("personal", f.identity)).entries[0].attempts,
    ).toBe(5);
    expect((await readObservationOutbox("personal", f.identity)).failed).toBe(
      5,
    );
    vi.setSystemTime(start + 86400001);
    expect(await deliverObservation("personal", packet.packageId, true)).toBe(
      false,
    );
    expect(hits).toBe(5);
  } finally {
    vi.useRealTimers();
  }
});
