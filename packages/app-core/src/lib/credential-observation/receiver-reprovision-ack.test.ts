/** real HTTP and AES/HMAC, not deployed-receiver proof. */
import { bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliverObservation } from "./delivery.js";
import { appendObservation } from "./queue.js";
import {
  configureObservationReceiver,
  getObservationReceiverStatus,
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

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function receiverFor(p: ReturnType<typeof provision>) {
  let state: ObservationReferenceState | null = null;
  return new ObservationReferenceReceiver(p, {
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(next) {
      state = structuredClone(next);
    },
  });
}
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("a held old HMAC ACK cannot alter a freshly reprovisioned same-owner receiver or its queue", async () => {
  const f = await fixture();
  const seen = barrier();
  const held = barrier();
  let count = 0;
  let receiver: ObservationReferenceReceiver;
  const origin = await listen(async (req, res) => {
    try {
      let raw = "";
      for await (const part of req) raw += part.toString();
      const ack = await receiver.receive(raw);
      count += 1;
      if (count === 1) {
        seen.release();
        await held.promise;
      }
      res.end(JSON.stringify(ack));
    } catch {
      res.writeHead(400).end();
    }
  });
  const original = provision(origin);
  receiver = receiverFor(original);
  await configureObservationReceiver({
    ...owner,
    provision: original,
    enabled: false,
  });
  const old = testObservationReceiver(owner);
  // Attach immediately so a setup failure never leaves an unhandled rejection.
  const outcome = old.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await seen.promise;
    const replacement = {
      ...original,
      receiverId: crypto.randomUUID(),
      bindingId: crypto.randomUUID(),
      keyEpoch: original.keyEpoch + 1,
      independentKeyMaterialB64: bytesToB64(
        crypto.getRandomValues(new Uint8Array(64)),
      ),
    };
    receiver = receiverFor(replacement);
    await configureObservationReceiver({
      ...owner,
      provision: replacement,
      enabled: false,
    });
    // Reprovisioning preserves the observation test's anti-replay interval.
    vi.setSystemTime(Date.now() + 61_000);
    expect(await testObservationReceiver(owner)).toEqual({ delivered: true });
    await setObservationReceiverEnabled({ ...owner, enabled: true });
    const current = await readReceiverConfig("personal");
    if (!current) throw new Error("Missing replacement receiver.");
    const packet = await withObservationLock("personal", () =>
      appendObservation(current, metadata(f.identity), false),
    );
    if (!packet) throw new Error("Missing replacement packet.");
    const before = await readObservationOutbox("personal", f.identity);
    held.release();
    expect(await outcome).toEqual({ value: { delivered: false } });
    expect(await readReceiverConfig("personal")).toEqual(current);
    expect(await readObservationOutbox("personal", f.identity)).toEqual(before);
    expect(await getObservationReceiverStatus("personal")).toMatchObject({
      receiverId: replacement.receiverId,
      verified: true,
      enabled: true,
      queued: 1,
    });
    expect(count).toBe(2);
    expect(await deliverObservation("personal", packet.packageId)).toBe(true);
    expect(
      (await readObservationOutbox("personal", f.identity)).entries,
    ).toHaveLength(0);
  } finally {
    held.release();
    await outcome;
  }
});

it("an oversized stream containing a genuine HMAC ACK is refused while a bounded current ACK succeeds", async () => {
  const f = await fixture();
  let oversize = true;
  const origin = await listen(async (req, res) => {
    try {
      let raw = "";
      for await (const part of req) raw += part.toString();
      const ack = JSON.stringify(await receiver.receive(raw));
      res.write(ack);
      // Trailing JSON whitespace preserves the genuine ACK but violates its wire bound.
      if (oversize) {
        res.write(" ".repeat(1024));
        res.write(" ".repeat(1025));
      }
      res.end();
    } catch {
      res.writeHead(400).end();
    }
  });
  const p = provision(origin);
  const receiver = receiverFor(p);
  await configureObservationReceiver({
    ...owner,
    provision: p,
    enabled: false,
  });
  expect(await testObservationReceiver(owner)).toEqual({ delivered: false });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    verified: false,
    failed: 1,
  });
  expect(
    (await readObservationOutbox("personal", f.identity)).entries,
  ).toHaveLength(1);
  oversize = false;
  vi.setSystemTime(Date.now() + 61_000);
  expect(await testObservationReceiver(owner)).toEqual({ delivered: true });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    verified: true,
  });
});
