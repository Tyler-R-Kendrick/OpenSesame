import { beforeEach, expect, it } from "vitest";
import {
  type Admission,
  type BrokerPorts,
  ExtensionRealmBroker,
  securityRequest,
} from "./broker.js";

function deferred<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Deferred promise not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (value: T) => finish(value) };
}

let revision: string | null;
let time: number;
let ports: BrokerPorts;
let broker: ExtensionRealmBroker;
beforeEach(() => {
  revision = "protected-header-generation-one";
  time = 1000;
  ports = {
    revision: async () => revision,
    classify: async (password) => {
      if (password === "owner-current") return { realm: "real" };
      if (password === "selected-retired")
        return {
          realm: "synthetic",
          trap: {
            id: "enrolled-trap",
            createdAt: "2026-10-05T00:00:00.000Z",
            response: "synthetic_decoy",
          },
        };
      throw new Error("Invalid credential");
    },
    now: () => time,
  };
  broker = new ExtensionRealmBroker(ports);
});

it("denies forged and synthetic permits while accepting a worker-admitted real permit", async () => {
  const real = await broker
    .attach()
    .handle({ id: 1, op: "unlock", password: "owner-current" });
  const synthetic = await broker
    .attach()
    .handle({ id: 2, op: "unlock", password: "selected-retired" });
  expect(real.realm).toBe("real");
  expect(real.trap).toBeUndefined();
  expect(synthetic).toMatchObject({
    realm: "synthetic",
    trap: { id: "enrolled-trap", response: "synthetic_decoy" },
  });
  await expect(broker.allows(real.permit)).resolves.toBe(true);
  await expect(broker.allows(synthetic.permit)).resolves.toBe(false);
  await expect(broker.allows("forged-real-principal")).resolves.toBe(false);
  await expect(broker.allows()).resolves.toBe(false);
});

it("revokes a disconnected client's permit without revoking another real port", async () => {
  const first = broker.attach();
  const second = broker.attach();
  const a = await first.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  const b = await second.handle({
    id: 2,
    op: "unlock",
    password: "owner-current",
  });
  first.close();
  first.close();
  await expect(broker.allows(a.permit)).resolves.toBe(false);
  await expect(broker.allows(b.permit)).resolves.toBe(true);
});

it("locking or entering a synthetic realm revokes only that client's previous authority", async () => {
  const realPort = broker.attach();
  const otherPort = broker.attach();
  const real = await realPort.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  const other = await otherPort.handle({
    id: 2,
    op: "unlock",
    password: "owner-current",
  });
  await expect(
    otherPort.handle({ id: 3, op: "unlock", password: "selected-retired" }),
  ).resolves.toMatchObject({ realm: "synthetic" });
  await expect(broker.allows(other.permit)).resolves.toBe(false);
  await expect(broker.allows(real.permit)).resolves.toBe(true);
  await expect(realPort.handle({ id: 4, op: "lock" })).resolves.toEqual({
    id: 4,
    realm: "locked",
  });
  await expect(broker.allows(real.permit)).resolves.toBe(false);
});

it("invalid password attempts revoke the requesting client's old permit", async () => {
  const client = broker.attach();
  const previous = await client.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  await expect(
    client.handle({ id: 2, op: "unlock", password: "incorrect" }),
  ).resolves.toEqual({
    id: 2,
    realm: "locked",
    error: "The password did not open this vault.",
  });
  await expect(broker.allows(previous.permit)).resolves.toBe(false);
});

it("expires permits exactly at the deadline and loses them on worker restart", async () => {
  const reply = await broker
    .attach()
    .handle({ id: 1, op: "unlock", password: "owner-current" });
  time += 299999;
  await expect(broker.allows(reply.permit)).resolves.toBe(true);
  const restarted = new ExtensionRealmBroker(ports);
  await expect(restarted.allows(reply.permit)).resolves.toBe(false);
  time += 1;
  await expect(broker.allows(reply.permit)).resolves.toBe(false);
});

it("denies an existing permit when the protected header revision changes", async () => {
  const reply = await broker
    .attach()
    .handle({ id: 1, op: "unlock", password: "owner-current" });
  revision = "protected-header-generation-two";
  await expect(broker.allows(reply.permit)).resolves.toBe(false);
});

it("does not downgrade a previously protected worker when the header disappears", async () => {
  const reply = await broker.attach().handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  revision = null;
  await expect(broker.allows(reply.permit)).resolves.toBe(false);
  await expect(broker.allows()).resolves.toBe(false);
});

it("refuses admission if the header changes during password classification", async () => {
  ports.classify = async () => {
    revision = "new-protected-header";
    return { realm: "real" };
  };
  await expect(
    broker.attach().handle({ id: 1, op: "unlock", password: "owner-current" }),
  ).resolves.toMatchObject({ realm: "locked" });
  await expect(broker.allows()).resolves.toBe(false);
});

it("refuses an in-flight unlock after a newer lock or disconnect", async () => {
  for (const interruption of ["lock", "disconnect"]) {
    const pendingAdmission = deferred<Admission>();
    ports.classify = () => pendingAdmission.promise;
    const client = broker.attach();
    const pending = client.handle({
      id: 1,
      op: "unlock",
      password: "owner-current",
    });
    await Promise.resolve();
    if (interruption === "lock") await client.handle({ id: 2, op: "lock" });
    else client.close();
    pendingAdmission.finish({ realm: "real" });
    const result = await pending;
    expect(result.realm).toBe("locked");
    await expect(broker.allows(result.permit)).resolves.toBe(false);
    client.close();
  }
});

it("does not resurrect authority when disconnect or lock races the final revision read", async () => {
  for (const interruption of ["lock", "disconnect"]) {
    const finalRevision = deferred<string | null>();
    const reachedFinalRead = deferred<void>();
    let reads = 0;
    ports.revision = async () => {
      reads += 1;
      if (reads === 2) {
        reachedFinalRead.finish();
        return finalRevision.promise;
      }
      return revision;
    };
    const client = broker.attach();
    const pending = client.handle({
      id: 1,
      op: "unlock",
      password: "owner-current",
    });
    await reachedFinalRead.promise;
    if (interruption === "lock") await client.handle({ id: 2, op: "lock" });
    else client.close();
    finalRevision.finish(revision);
    const result = await pending;
    expect(result.realm).toBe("locked");
    await expect(broker.allows(result.permit)).resolves.toBe(false);
    client.close();
  }
});

it("keeps the newer synthetic classification when concurrent unlocks finish out of order", async () => {
  const olderAdmission = deferred<Admission>();
  const classificationStarted = deferred<void>();
  const classify = ports.classify;
  ports.classify = async (password) => {
    if (password === "owner-current") {
      classificationStarted.finish();
      return olderAdmission.promise;
    }
    return classify(password);
  };
  const client = broker.attach();
  const older = client.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  await classificationStarted.promise;
  const newer = await client.handle({
    id: 2,
    op: "unlock",
    password: "selected-retired",
  });
  expect(newer.realm).toBe("synthetic");
  olderAdmission.finish({ realm: "real" });
  const stale = await older;
  expect(stale.realm).toBe("locked");
  await expect(broker.allows(stale.permit)).resolves.toBe(false);
  await expect(broker.allows(newer.permit)).resolves.toBe(false);
});

it("allows at most 32 live clients and frees a slot after disconnect", () => {
  const clients = Array.from({ length: 32 }, () => broker.attach());
  expect(() => broker.attach()).toThrow(/Too many/);
  clients[0]?.close();
  expect(() => broker.attach()).not.toThrow();
});

it("requires secret-safe closed requests without caller-supplied realms or permits", () => {
  for (const request of [
    { id: 1, op: "unlock", password: "owner-current", realm: "real" },
    { id: 1, op: "unlock", password: "owner-current", permit: "forged" },
    { id: 1, op: "unlock", password: "" },
    { id: 1, op: "unlock", password: "a".repeat(1025) },
    { id: -1, op: "lock" },
    { id: 1, op: "export-real-secret" },
  ])
    expect(securityRequest.safeParse(request).success).toBe(false);
});

it("preserves the preexisting consent boundary for installations without a protected vault", async () => {
  revision = null;
  await expect(broker.allows()).resolves.toBe(true);
  await expect(
    broker.attach().handle({ id: 1, op: "unlock", password: "owner-current" }),
  ).resolves.toMatchObject({ realm: "locked" });
});

it("confines human management to its original real port and fresh password callback", async () => {
  let calls = 0;
  ports.manage = async (_operation, password, check) => {
    check();
    calls += 1;
    if (password !== "owner-current") throw new Error("Invalid owner proof");
    return JSON.stringify({ configured: false });
  };
  const owner = broker.attach();
  const other = broker.attach();
  const real = await owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  const synthetic = await other.handle({
    id: 2,
    op: "unlock",
    password: "selected-retired",
  });
  if (!real.permit || !synthetic.permit)
    throw new Error("Expected worker-issued permits");
  const request = securityRequest.parse({
    id: 3,
    op: "manage",
    permit: real.permit,
    password: "owner-current",
    operation: { verb: "receiver-status" },
  });
  if (request.op !== "manage")
    throw new Error("Expected closed management request");
  expect((await other.handle(request)).realm).toBe("locked");
  expect(
    (await other.handle({ ...request, permit: synthetic.permit })).realm,
  ).toBe("locked");
  expect(calls).toBe(0);
  expect((await owner.handle({ ...request, password: "wrong" })).realm).toBe(
    "locked",
  );
  expect((await owner.handle(request)).resultJson).toBe(
    JSON.stringify({ configured: false }),
  );
  expect(calls).toBe(2);
});

it("suppresses a late management reply after its owner port disconnects", async () => {
  const pending = deferred<string>();
  const started = deferred<void>();
  ports.manage = async () => {
    started.finish();
    return pending.promise;
  };
  const owner = broker.attach();
  const real = await owner.handle({
    id: 1,
    op: "unlock",
    password: "owner-current",
  });
  if (!real.permit) throw new Error("Expected worker-issued real permit");
  const result = owner.handle({
    id: 2,
    op: "manage",
    permit: real.permit,
    password: "owner-current",
    operation: { verb: "canary-status" },
  });
  await started.promise;
  owner.close();
  pending.finish(JSON.stringify({ artifacts: [] }));
  const reply = await result;
  expect(reply.realm).toBe("locked");
  expect(reply.resultJson).toBeUndefined();
});

it("rejects undeclared management actions and extra secret-bearing fields", () => {
  const base = {
    id: 1,
    op: "manage",
    permit: "permit",
    password: "current",
    operation: { verb: "canary-status" },
  };
  expect(securityRequest.safeParse(base).success).toBe(true);
  expect(
    securityRequest.safeParse({ ...base, operation: { verb: "vault-export" } })
      .success,
  ).toBe(false);
  expect(
    securityRequest.safeParse({
      ...base,
      operation: { verb: "canary-status", token: "untrusted" },
    }).success,
  ).toBe(false);
});
