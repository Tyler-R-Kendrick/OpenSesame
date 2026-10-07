import { expect, it } from "vitest";
import { deferred, managementBridge } from "./management.fixture.js";

it("denies retained direct management requests without disabling an independent real worker port", async () => {
  for (const interruption of [
    "missing",
    "lock",
    "close",
    "expiry",
    "reauthenticate",
  ]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    const original = f.client.permit();
    if (!original) throw new Error("Expected a worker-issued owner permit");
    if (interruption === "lock") f.client.lock();
    if (interruption === "close") f.close();
    if (interruption === "expiry") f.state.now += 300000;
    if (interruption === "reauthenticate")
      await f.client.unlock("owner-current");
    // Admit the other port after expiry so its independent lease is current.
    const other = f.openWorkerPort();
    const peer = await other.handle({
      id: 10,
      op: "unlock",
      password: "owner-current",
    });
    if (!peer.permit) throw new Error("Expected a worker-issued peer permit");
    const request = {
      id: 11,
      op: "manage" as const,
      permit: interruption === "missing" ? crypto.randomUUID() : original,
      password: "owner-current",
      operation: { verb: "receiver-status" as const },
    };
    const rejected = await f.worker.handle(request);
    expect(rejected.realm).toBe("locked");
    expect(rejected.resultJson).toBeUndefined();
    expect(f.managementCalls()).toBe(0);
    await expect(
      other.handle({ id: 12, op: "authorize", permit: peer.permit }),
    ).resolves.toMatchObject({ realm: "real" });
    await expect(
      other.handle({ ...request, id: 13, permit: peer.permit }),
    ).resolves.toMatchObject({
      realm: "real",
      resultJson: JSON.stringify({ selected: "owner-only-result" }),
    });
    expect(f.managementCalls()).toBe(1);
    other.close();
    f.close();
  }
});

it("refuses unadmitted management before reading the owner's authoritative revision", async () => {
  for (const interruption of [
    "unknown",
    "foreign",
    "synthetic",
    "expiry",
    "closed",
  ]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    let permit = f.client.permit();
    const other = f.openWorkerPort();
    if (interruption === "unknown") permit = crypto.randomUUID();
    if (interruption === "foreign") {
      permit = (
        await other.handle({ id: 1, op: "unlock", password: "owner-current" })
      ).permit;
    }
    if (interruption === "synthetic") {
      await f.client.unlock("selected-retired");
      permit = f.client.permit();
    }
    if (interruption === "expiry") f.state.now += 300000;
    if (interruption === "closed") f.close();
    if (!permit)
      throw new Error("Expected the actual worker-issued or unknown permit");
    const before = f.revisionCalls();
    const request = {
      id: 2,
      op: "manage" as const,
      permit,
      password: "owner-current",
      operation: { verb: "receiver-status" as const },
    };
    expect(await f.worker.handle(request)).toEqual({
      id: 2,
      realm: "locked",
      error: "Owner management failed. Authenticate again.",
    });
    expect(f.revisionCalls()).toBe(before);
    expect(f.managementCalls()).toBe(0);
    const fresh = await other.handle({
      id: 3,
      op: "unlock",
      password: "owner-current",
    });
    if (!fresh.permit) throw new Error("Expected a fresh real worker permit");
    await expect(
      other.handle({ ...request, id: 4, permit: fresh.permit }),
    ).resolves.toMatchObject({
      realm: "real",
      resultJson: JSON.stringify({ selected: "owner-only-result" }),
    });
    expect(f.revisionCalls()).toBeGreaterThan(before);
    expect(f.managementCalls()).toBe(1);
    other.close();
    f.close();
  }
});

it("expires the original admission after authorization without dispatching its management password", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  f.holdReplies();
  // The initial lease check reads once, and allows reads once. Expire the
  // actual trusted clock as allows hands its verdict back to its caller.
  f.afterClockReads(2, () => {
    f.state.now += 300000;
  });
  const pending = f.client.manage({ verb: "receiver-status" }, "owner-current");
  const denied = expect(pending).rejects.toThrow("Owner management failed");
  const reply = await f.nextReply();
  expect(reply.reply.realm).toBe("locked");
  expect(reply.reply.resultJson).toBeUndefined();
  expect(f.callbackDispatches()).toBe(0);
  expect(f.managementCalls()).toBe(0);
  reply.deliver();
  await denied;
  await f.client.unlock("owner-current");
  const fresh = f.client.manage({ verb: "receiver-status" }, "owner-current");
  const accepted = await f.nextReply();
  expect(accepted.reply.realm).toBe("real");
  accepted.deliver();
  await expect(fresh).resolves.toContain("owner-only-result");
  expect(f.callbackDispatches()).toBe(1);
  f.close();
});

it("rejects a returned owner result before revision I/O after its port closes or expires", async () => {
  for (const interruption of ["close", "expiry"]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    const resume = deferred<string>();
    f.blockManagement(resume.promise);
    f.holdReplies();
    const pending = f.client.manage(
      { verb: "receiver-status" },
      "owner-current",
    );
    const denied = expect(pending).rejects.toThrow("Owner management failed");
    await f.started;
    const reads = f.revisionCalls();
    if (interruption === "close") f.close();
    else f.state.now += 300000;
    resume.finish(JSON.stringify({ captured: "owner-metadata" }));
    const reply = await f.nextReply();
    expect(reply.reply.realm).toBe("locked");
    expect(reply.reply.resultJson).toBeUndefined();
    expect(f.revisionCalls()).toBe(reads);
    expect(f.callbackDispatches()).toBe(1);
    reply.deliver();
    await denied;
    const peer = f.openWorkerPort();
    const current = await peer.handle({
      id: 1,
      op: "unlock",
      password: "owner-current",
    });
    if (!current.permit) throw new Error("Expected a current real peer permit");
    await expect(
      peer.handle({
        id: 2,
        op: "manage",
        permit: current.permit,
        password: "owner-current",
        operation: { verb: "receiver-status" },
      }),
    ).resolves.toMatchObject({
      realm: "real",
      resultJson: JSON.stringify({ captured: "owner-metadata" }),
    });
    expect(f.callbackDispatches()).toBe(2);
    peer.close();
    f.close();
  }
});

it("withholds a direct worker result when its original port closes as final authorization returns", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  const permit = f.client.permit();
  if (!permit) throw new Error("Expected an original real worker permit");
  f.performManagement(async (check) => {
    check();
    // Observe the post-callback check then the final allows clock read. The
    // actual port closes in the microtask before the awaited verdict returns.
    f.afterClockReads(2, f.close);
    return JSON.stringify({ captured: "must-not-return-to-retired-port" });
  });
  const request = {
    id: 1,
    op: "manage" as const,
    permit,
    password: "owner-current",
    operation: { verb: "receiver-status" as const },
  };
  const reply = await f.worker.handle(request);
  expect(reply.realm).toBe("locked");
  expect(reply.resultJson).toBeUndefined();
  expect(f.callbackDispatches()).toBe(1);
  const peer = f.openWorkerPort();
  const current = await peer.handle({
    id: 2,
    op: "unlock",
    password: "owner-current",
  });
  if (!current.permit) throw new Error("Expected a current real peer permit");
  await expect(
    peer.handle({ ...request, id: 3, permit: current.permit }),
  ).resolves.toMatchObject({
    realm: "real",
    resultJson: JSON.stringify({ captured: "must-not-return-to-retired-port" }),
  });
  expect(f.callbackDispatches()).toBe(2);
  peer.close();
});
