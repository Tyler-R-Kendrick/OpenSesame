import { expect, it } from "vitest";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import { queueCredentialObservation } from "./queue.js";
import {
  configureObservationReceiver,
  getObservationReceiverStatus,
  removeObservationReceiver,
  setObservationReceiverEnabled,
  testObservationReceiver,
} from "./receiver.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "./reference.js";
import { readObservationOutbox } from "./storage.js";
import { fixture, listen, owner, provision } from "./test-support.js";
it("requires real owner proof then HMAC ACK before enabling; dispatches only closed sealed metadata without ambient authority", async () => {
  const f = await fixture();
  let state: ObservationReferenceState | null = null;
  const wire: string[] = [];
  const headers: Array<{
    cookie?: string;
    authorization?: string;
    path?: string;
    method?: string;
  }> = [];
  const origin = await listen(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part.toString();
    wire.push(raw);
    headers.push({
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      path: req.url,
      method: req.method,
    });
    try {
      res.end(JSON.stringify(await receiver.receive(raw)));
    } catch {
      res.writeHead(400).end();
    }
  });
  const p = provision(origin);
  const receiver = new ObservationReferenceReceiver(p, {
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(s) {
      state = structuredClone(s);
    },
  });
  await expect(
    configureObservationReceiver({
      ...owner,
      currentPassword: "wrong",
      provision: p,
      enabled: true,
    }),
  ).rejects.toThrow();
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: false,
  });
  await configureObservationReceiver({ ...owner, provision: p, enabled: true });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: true,
    enabled: false,
    verified: false,
  });
  await expect(
    setObservationReceiverEnabled({ ...owner, enabled: true }),
  ).rejects.toThrow("Test the observation receiver");
  expect(await testObservationReceiver(owner)).toEqual({ delivered: true });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: false,
    verified: true,
  });
  await setObservationReceiverEnabled({ ...owner, enabled: true });
  const event = {
    v: 1 as const,
    eventId: crypto.randomUUID(),
    vaultIdentity: f.identity,
    type: "retired_credential_observed" as const,
    trapId: "synthetic-control",
    response: "reject" as const,
    at: new Date().toISOString(),
  };
  f.store.lock();
  await f.store.createGuest({ decoy: true, isolated: true, resume: false });
  await queueCredentialObservation("personal", event);
  await flushRetiredCredentialTelemetry();
  expect(wire).toHaveLength(2);
  expect(wire[1]).not.toContain(f.identity);
  expect(wire[1]).not.toContain(event.trapId);
  expect(wire[1]).not.toContain(owner.currentPassword);
  expect(
    headers.every(
      (h) =>
        h.cookie === undefined &&
        h.authorization === undefined &&
        h.method === "POST" &&
        h.path === "/v1/credential-observations",
    ),
  ).toBe(true);
  expect(
    (await readObservationOutbox("personal", f.identity)).entries,
  ).toHaveLength(0);
  expect(f.store.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: true,
  });
  await expect(getObservationReceiverStatus("personal")).rejects.toThrow();
  f.store.lock();
  f.store.rehydrate();
  await f.store.unlock(owner.currentPassword);
  await removeObservationReceiver(owner);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: false,
  });
});
it("rejects unauthenticated success responses and refuses to follow redirects", async () => {
  await fixture();
  let targetHits = 0;
  const target = await listen((_req, res) => {
    targetHits++;
    res.end("{}");
  });
  const origin = await listen((_req, res) =>
    res.writeHead(307, { location: target }).end(),
  );
  await configureObservationReceiver({
    ...owner,
    provision: provision(origin),
    enabled: false,
  });
  expect(await testObservationReceiver(owner)).toEqual({ delivered: false });
  expect(targetHits).toBe(0);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    verified: false,
    failed: 1,
  });
  const falseSuccess = await listen((_req, res) => res.end("{}"));
  await configureObservationReceiver({
    ...owner,
    provision: provision(falseSuccess),
    enabled: false,
  });
  // Fresh provision does not reset the persisted per-hour abuse budget.
  expect(await testObservationReceiver(owner)).toEqual({ delivered: false });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    verified: false,
    failed: 1,
  });
});

it("does not treat an unauthenticated HTTP success as delivery", async () => {
  await fixture();
  const origin = await listen((_req, res) => res.end("{}"));
  await configureObservationReceiver({
    ...owner,
    provision: provision(origin),
    enabled: false,
  });
  expect(await testObservationReceiver(owner)).toEqual({ delivered: false });
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    verified: false,
    failed: 1,
  });
});
it("a valid held ACK cannot verify receiver settings after the public owner lock", async () => {
  const f = await fixture();
  let state: ObservationReferenceState | null = null;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const seen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const origin = await listen(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part.toString();
    const ack = await receiver.receive(raw);
    observed();
    await held;
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
  const testing = testObservationReceiver(owner);
  const rejection = expect(testing).rejects.toThrow();
  await seen;
  f.store.lock();
  release();
  await rejection;
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: false,
    verified: false,
  });
  expect(f.store.getSnapshot().status).toBe("locked");
});
