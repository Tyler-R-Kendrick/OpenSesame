import { expect, it } from "vitest";
import { type BrokerPorts, ExtensionRealmBroker } from "./broker.js";

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

interface HeaderState {
  revision: string | null;
  now: number;
}

function fixture() {
  const state: HeaderState = {
    revision: "protected-header",
    now: 1000,
  };
  const ports: BrokerPorts = {
    revision: async () => state.revision,
    now: () => state.now,
    classify: async (password) =>
      password === "selected-retired"
        ? {
            realm: "synthetic",
            trap: {
              id: "selected",
              createdAt: "2026-10-05T00:00:00.000Z",
              response: "synthetic_decoy",
            },
          }
        : { realm: "real" },
  };
  const broker = new ExtensionRealmBroker(ports);
  return { state, ports, broker, owner: broker.attach() };
}

it("authorizes only a live real permit on the worker port that owns it", async () => {
  const f = fixture();
  const real = await f.owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  await expect(
    f.owner.handle({ id: 2, op: "authorize", permit: real.permit }),
  ).resolves.toEqual({ id: 2, realm: "real" });
  const foreign = f.broker.attach();
  await expect(
    foreign.handle({ id: 3, op: "authorize", permit: real.permit }),
  ).resolves.toEqual({ id: 3, realm: "locked" });
  await expect(
    f.owner.handle({ id: 4, op: "authorize", permit: "forged-permit" }),
  ).resolves.toEqual({ id: 4, realm: "locked" });
  await expect(f.owner.handle({ id: 5, op: "authorize" })).resolves.toEqual({
    id: 5,
    realm: "locked",
  });
  const synthetic = await f.owner.handle({
    id: 6,
    op: "unlock",
    password: "selected-retired",
  });
  await expect(
    f.owner.handle({ id: 7, op: "authorize", permit: synthetic.permit }),
  ).resolves.toEqual({ id: 7, realm: "locked" });
});

it("rejects authorizations at expiry without relying on the page to forget a permit", async () => {
  const f = fixture();
  const real = await f.owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  f.state.now += 299999;
  await expect(
    f.owner.handle({ id: 2, op: "authorize", permit: real.permit }),
  ).resolves.toMatchObject({ realm: "real" });
  f.state.now += 1;
  await expect(
    f.owner.handle({ id: 3, op: "authorize", permit: real.permit }),
  ).resolves.toMatchObject({ realm: "locked" });
});

it("withholds an in-flight authorization after lock or disconnect during its revision await", async () => {
  for (const interruption of ["lock", "disconnect"]) {
    const f = fixture();
    const real = await f.owner.handle({
      id: 1,
      op: "unlock",
      password: "owner-current",
    });
    const readStarted = deferred<void>();
    const pendingRevision = deferred<string | null>();
    f.ports.revision = async () => {
      readStarted.finish();
      return pendingRevision.promise;
    };
    const pending = f.owner.handle({
      id: 2,
      op: "authorize",
      permit: real.permit,
    });
    await readStarted.promise;
    if (interruption === "lock") await f.owner.handle({ id: 3, op: "lock" });
    else f.owner.close();
    pendingRevision.finish(f.state.revision);
    await expect(pending).resolves.toEqual({ id: 2, realm: "locked" });
  }
});

it("rejects a live page-held permit when the authoritative revision changes during the check", async () => {
  const f = fixture();
  const real = await f.owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  const readStarted = deferred<void>();
  const pendingRevision = deferred<string | null>();
  f.ports.revision = async () => {
    readStarted.finish();
    return pendingRevision.promise;
  };
  const pending = f.owner.handle({
    id: 2,
    op: "authorize",
    permit: real.permit,
  });
  await readStarted.promise;
  f.state.revision = "rotated-header";
  pendingRevision.finish(f.state.revision);
  await expect(pending).resolves.toEqual({ id: 2, realm: "locked" });
});

it("retains legacy consent without permitting a protected-to-missing-header downgrade", async () => {
  const f = fixture();
  f.state.revision = null;
  await expect(f.owner.handle({ id: 1, op: "authorize" })).resolves.toEqual({
    id: 1,
    realm: "real",
  });
  f.state.revision = "protected-header";
  await expect(f.owner.handle({ id: 2, op: "authorize" })).resolves.toEqual({
    id: 2,
    realm: "locked",
  });
  f.state.revision = null;
  await expect(f.owner.handle({ id: 3, op: "authorize" })).resolves.toEqual({
    id: 3,
    realm: "locked",
  });
});

it("rechecks lease identity when lock revokes authority after the internal allow decision", async () => {
  const f = fixture();
  const real = await f.owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  f.ports.now = () => {
    void f.owner.handle({ id: 3, op: "lock" });
    return f.state.now;
  };
  await expect(
    f.owner.handle({ id: 2, op: "authorize", permit: real.permit }),
  ).resolves.toEqual({ id: 2, realm: "locked" });
});
