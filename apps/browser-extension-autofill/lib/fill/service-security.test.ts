import { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import { expect, it } from "vitest";
import type { FilledValue } from "./daemon";
import { type BackgroundReply, createFillService } from "./service";
import { VALUE, ask, guardSender, harness, popup } from "./service-harness";

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

async function admission(password = "owner-current") {
  const broker = new ExtensionRealmBroker({
    revision: async () => "protected-header",
    classify: async (submitted) =>
      submitted === "selected-retired"
        ? {
            realm: "synthetic",
            trap: {
              id: "selected",
              createdAt: "2026-10-05T00:00:00.000Z",
              response: "synthetic_decoy",
            },
          }
        : { realm: "real" },
    now: () => 1000,
  });
  const client = broker.attach();
  const reply = await client.handle({ id: 1, op: "unlock", password });
  return { broker, client, authorize: () => broker.allows(reply.permit) };
}

it("refuses daemon values for a worker-admitted synthetic realm", async () => {
  const synthetic = await admission("selected-retired");
  const h = harness();
  const service = createFillService(h.ports);
  let valueReply: BackgroundReply | undefined;
  h.guard = async (message) => {
    valueReply = await service.handle(
      ask({ op: "value", nonce: message.nonce, field: "password" }),
      guardSender(),
    );
    return { outcome: "vault_locked" };
  };
  await expect(
    service.handle(ask({ op: "trigger" }), popup, synthetic.authorize),
  ).resolves.toEqual({ error: "vault_locked" });
  expect(valueReply).toBeUndefined();
  expect(h.daemonCalls).toEqual([]);
  expect(h.sent).toEqual([]);
  expect(service.ledger.size).toBe(0);
});

it("binds the gesture to its original real permit and spends the nonce on revocation", async () => {
  const real = await admission();
  const h = harness();
  const service = createFillService(h.ports);
  await service.handle(ask({ op: "trigger" }), popup, real.authorize);
  const nonce = h.sent[0]?.nonce;
  if (!nonce) throw new Error("No gesture armed");
  await real.client.handle({ id: 2, op: "lock" });
  const request = ask({ op: "value", nonce, field: "password" });
  // A content request cannot replace the worker closure captured by its arm.
  await expect(
    service.handle(request, guardSender(), async () => true),
  ).resolves.toEqual({ refusal: "vault_locked" });
  await expect(
    service.handle(request, guardSender(), async () => true),
  ).resolves.toEqual({ refusal: "unknown_gesture" });
  expect(h.daemonCalls.some((call) => call.startsWith("value"))).toBe(false);
});

it("withholds a real secret when the permit is revoked during the daemon await", async () => {
  const real = await admission();
  const daemonStarted = deferred<void>();
  const daemonResult = deferred<FilledValue>();
  let valueCalls = 0;
  const h = harness({
    value: async () => {
      valueCalls += 1;
      daemonStarted.finish();
      return daemonResult.promise;
    },
  });
  const service = createFillService(h.ports);
  await service.handle(ask({ op: "trigger" }), popup, real.authorize);
  const nonce = h.sent[0]?.nonce;
  if (!nonce) throw new Error("No gesture armed");
  const request = ask({ op: "value", nonce, field: "password" });
  const pending = service.handle(request, guardSender());
  await daemonStarted.promise;
  real.client.close();
  daemonResult.finish({ value: VALUE, pepper: false });
  const reply = await pending;
  expect(reply).toEqual({ refusal: "vault_locked" });
  expect(JSON.stringify(reply)).not.toContain(VALUE);
  await expect(service.handle(request, guardSender())).resolves.toEqual({
    refusal: "unknown_gesture",
  });
  expect(valueCalls).toBe(1);
});

it("refuses the daemon call when admission is revoked during site verification", async () => {
  const real = await admission();
  const h = harness();
  const service = createFillService(h.ports);
  await service.handle(ask({ op: "trigger" }), popup, real.authorize);
  const nonce = h.sent[0]?.nonce;
  if (!nonce) throw new Error("No gesture armed");
  const siteRead = deferred<boolean>();
  const siteStarted = deferred<void>();
  h.ports.sites.isEnabled = async () => {
    siteStarted.finish();
    return siteRead.promise;
  };
  const request = ask({ op: "value", nonce, field: "password" });
  const pending = service.handle(request, guardSender());
  await siteStarted.promise;
  real.client.close();
  siteRead.finish(true);
  await expect(pending).resolves.toEqual({ refusal: "vault_locked" });
  expect(h.daemonCalls.some((call) => call.startsWith("value"))).toBe(false);
  await expect(service.handle(request, guardSender())).resolves.toEqual({
    refusal: "unknown_gesture",
  });
});

it("returns only an outcome to the popup while a fresh real gesture fills exactly once", async () => {
  const real = await admission();
  const h = harness();
  const service = createFillService(h.ports);
  let valueReply: BackgroundReply | undefined;
  h.guard = async (message) => {
    valueReply = await service.handle(
      ask({ op: "value", nonce: message.nonce, field: "password" }),
      guardSender(),
    );
    return { outcome: "filled" };
  };
  const result = await service.handle(
    ask({ op: "trigger" }),
    popup,
    real.authorize,
  );
  expect(result).toEqual({ outcome: "filled" });
  expect(valueReply).toEqual({ value: VALUE });
  expect(JSON.stringify(result)).not.toContain(VALUE);
  expect(JSON.stringify(h.sent)).not.toContain(VALUE);
  expect(JSON.stringify([...h.stored])).not.toContain(VALUE);
  expect(service.ledger.size).toBe(0);
  expect(h.daemonCalls.filter((call) => call.startsWith("value"))).toHaveLength(
    1,
  );
});

it("refuses the spent old gesture after fresh authentication but accepts a new gesture", async () => {
  const old = await admission();
  const h = harness();
  const service = createFillService(h.ports);
  await service.handle(ask({ op: "trigger" }), popup, old.authorize);
  const oldNonce = h.sent[0]?.nonce;
  if (!oldNonce) throw new Error("No old gesture armed");
  old.client.close();
  await expect(
    service.handle(
      ask({ op: "value", nonce: oldNonce, field: "password" }),
      guardSender(),
    ),
  ).resolves.toEqual({ refusal: "vault_locked" });
  const fresh = await admission();
  await service.handle(ask({ op: "trigger" }), popup, fresh.authorize);
  const newNonce = h.sent.at(-1)?.nonce;
  if (!newNonce) throw new Error("No fresh gesture armed");
  await expect(
    service.handle(
      ask({ op: "value", nonce: oldNonce, field: "password" }),
      guardSender(),
      fresh.authorize,
    ),
  ).resolves.toEqual({ refusal: "unknown_gesture" });
  await expect(
    service.handle(
      ask({ op: "value", nonce: newNonce, field: "password" }),
      guardSender(),
    ),
  ).resolves.toEqual({ value: VALUE });
});
