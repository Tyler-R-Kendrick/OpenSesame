import { expect, it } from "vitest";
import {
  type Admission,
  type BrokerPorts,
  ExtensionRealmBroker,
} from "./broker.js";

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

function fixture() {
  const pending = deferred<Admission>();
  let calls = 0;
  const ports: BrokerPorts = {
    revision: async () => "protected-header",
    classify: async () => {
      calls += 1;
      return pending.promise;
    },
    now: () => 1000,
  };
  return {
    broker: new ExtensionRealmBroker(ports),
    pending,
    ports,
    calls: () => calls,
  };
}

it("bounds one port to two overlapping classifications and invalidates superseded replies", async () => {
  const f = fixture();
  const owner = f.broker.attach();
  const first = owner.handle({ id: 1, op: "unlock", password: "one" });
  const second = owner.handle({ id: 2, op: "unlock", password: "two" });
  await expect(
    owner.handle({ id: 3, op: "unlock", password: "three" }),
  ).resolves.toEqual({ id: 3, realm: "locked" });
  expect(f.calls()).toBe(2);
  f.pending.finish({ realm: "real" });
  await expect(first).resolves.toMatchObject({ realm: "locked" });
  await expect(second).resolves.toMatchObject({ realm: "locked" });
  await expect(
    owner.handle({ id: 4, op: "unlock", password: "fresh" }),
  ).resolves.toMatchObject({ realm: "real" });
  expect(f.calls()).toBe(3);
});

it("keeps classification slots occupied after lock and disconnect until work settles", async () => {
  const f = fixture();
  const owners = Array.from({ length: 16 }, () => f.broker.attach());
  const pending = owners.flatMap((owner) => [
    owner.handle({ id: 1, op: "unlock", password: "one" }),
    owner.handle({ id: 2, op: "unlock", password: "two" }),
  ]);
  await Promise.all(owners.map((owner) => owner.handle({ id: 3, op: "lock" })));
  expect(f.calls()).toBe(2);
  for (const owner of owners) owner.close();
  const replacement = f.broker.attach();
  await expect(
    replacement.handle({ id: 4, op: "unlock", password: "replacement" }),
  ).resolves.toEqual({ id: 4, realm: "locked" });
  expect(f.calls()).toBe(2);
  f.pending.finish({ realm: "real" });
  const stale = await Promise.all(pending);
  expect(stale.every((reply) => reply.realm === "locked")).toBe(true);
  const fresh = await replacement.handle({
    id: 5,
    op: "unlock",
    password: "fresh",
  });
  expect(fresh.realm).toBe("real");
  await expect(f.broker.allows(fresh.permit)).resolves.toBe(true);
  expect(f.calls()).toBe(3);
});

it("rejects excess global work after revoking that port's previously admitted real lease", async () => {
  const f = fixture();
  const owner = f.broker.attach();
  f.ports.classify = async () => ({ realm: "real" });
  const previous = await owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  await expect(f.broker.allows(previous.permit)).resolves.toBe(true);
  f.ports.classify = async () => f.pending.promise;
  const others = Array.from({ length: 16 }, () => f.broker.attach());
  const pending = others.flatMap((client) => [
    client.handle({ id: 1, op: "unlock", password: "one" }),
    client.handle({ id: 2, op: "unlock", password: "two" }),
  ]);
  await expect(
    owner.handle({ id: 2, op: "unlock", password: "excess" }),
  ).resolves.toMatchObject({ realm: "locked" });
  await expect(f.broker.allows(previous.permit)).resolves.toBe(false);
  f.pending.finish({ realm: "real" });
  await Promise.all(pending);
});

it("releases worker and port capacity after failed classification", async () => {
  const f = fixture();
  const owner = f.broker.attach();
  f.ports.classify = async () => {
    throw new Error("Classifier failed");
  };
  for (let i = 0; i < 40; i++)
    await expect(
      owner.handle({ id: i, op: "unlock", password: "bad" }),
    ).resolves.toMatchObject({ realm: "locked" });
  f.ports.classify = async () => ({ realm: "real" });
  await expect(
    owner.handle({ id: 40, op: "unlock", password: "fresh" }),
  ).resolves.toMatchObject({ realm: "real" });
});

it("starts no password work on a disconnected port", async () => {
  const f = fixture();
  const owner = f.broker.attach();
  owner.close();
  await expect(
    owner.handle({ id: 1, op: "unlock", password: "after-close" }),
  ).resolves.toEqual({ id: 1, realm: "locked" });
  expect(f.calls()).toBe(0);
});
