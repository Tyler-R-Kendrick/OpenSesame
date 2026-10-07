import { expect, it } from "vitest";
import { deferred, managementBridge } from "./management.fixture.js";

it("returns management data only after the real worker accepts its owner permit and current password", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  await expect(
    f.client.manage({ verb: "receiver-status" }, "wrong-password"),
  ).rejects.toThrow("Owner management failed");
  await expect(
    f.client.manage({ verb: "receiver-status" }, "owner-current"),
  ).resolves.toBe(JSON.stringify({ selected: "owner-only-result" }));
});

it("withholds a delivered management reply when lock, unlock, or lock-and-unlock races its page continuation", async () => {
  for (const interruption of ["lock", "unlock", "lock-and-unlock"]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    f.holdReplies();
    const pending = f.client.manage(
      { verb: "receiver-status" },
      "owner-current",
    );
    const denied = expect(pending).rejects.toThrow("Owner management failed");
    const delivered = await f.nextReply();
    expect(delivered.reply.realm).toBe("real");
    expect(delivered.reply.resultJson).toContain("owner-only-result");
    delivered.deliver();
    if (interruption !== "unlock") f.client.lock();
    if (interruption !== "lock") {
      await expect(f.client.unlock("owner-current")).resolves.toMatchObject({
        realm: "real",
      });
    }
    await denied;
    if (interruption === "lock") expect(f.client.permit()).toBeUndefined();
    else expect(f.client.permit()).toBeDefined();
  }
});

it("the worker withholds management results when policy revision or lease expiry changes during management", async () => {
  for (const interruption of ["revision", "expiry"]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    const blocked = deferred<string>();
    f.blockManagement(blocked.promise);
    f.holdReplies();
    const pending = f.client.manage(
      { verb: "receiver-status" },
      "owner-current",
    );
    const denied = expect(pending).rejects.toThrow("Owner management failed");
    await f.started;
    if (interruption === "revision") f.state.revision = "peer-changed-policy";
    else f.state.now += 300000;
    blocked.finish(JSON.stringify({ selected: "must-not-return" }));
    const withheld = await f.nextReply();
    expect(withheld.reply.realm).toBe("locked");
    expect(withheld.reply.resultJson).toBeUndefined();
    withheld.deliver();
    await denied;
  }
});

it("bounds pending management replies and recovers client capacity after the actual replies settle", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  f.holdReplies();
  const pending = Array.from({ length: 32 }, () =>
    f.client.manage({ verb: "receiver-status" }, "owner-current"),
  );
  const settled = Promise.allSettled(pending);
  await expect(
    f.client.manage({ verb: "receiver-status" }, "owner-current"),
  ).rejects.toThrow("Authenticate the owner again");
  expect(f.sent.filter((request) => request.op === "manage")).toHaveLength(32);
  const replies = await Promise.all(
    Array.from({ length: 32 }, () => f.nextReply()),
  );
  for (const reply of replies) reply.deliver();
  const results = await settled;
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  const fresh = f.client.manage({ verb: "receiver-status" }, "owner-current");
  const reply = await f.nextReply();
  expect(reply.reply.realm).toBe("real");
  reply.deliver();
  await expect(fresh).resolves.toContain("owner-only-result");
});

it("releases failed-post management slots so transport failures cannot exhaust the page", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  f.failPosts(true);
  const before = f.attemptedPosts();
  for (let index = 0; index < 40; index++)
    await expect(
      f.client.manage({ verb: "receiver-status" }, "owner-current"),
    ).rejects.toThrow("Owner management failed");
  expect(f.attemptedPosts() - before).toBe(40);
  f.failPosts(false);
  await expect(
    f.client.manage({ verb: "receiver-status" }, "owner-current"),
  ).resolves.toContain("owner-only-result");
});

it("prevents a privileged callback commit after its original port is locked, closed, or expires", async () => {
  for (const interruption of ["none", "lock", "close", "expiry"]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    const resume = deferred<void>();
    const finished = deferred<void>();
    let commits = 0;
    // This models the privileged adapter's commit contract, using the actual
    // worker-supplied lease check. It does not substitute a vault owner proof.
    f.performManagement(async (check) => {
      await resume.promise;
      try {
        check();
        commits += 1;
        return JSON.stringify({ committed: true });
      } finally {
        finished.finish();
      }
    });
    const pending = f.client.manage(
      { verb: "receiver-status" },
      "owner-current",
    );
    const result = Promise.allSettled([pending]);
    await f.started;
    if (interruption === "lock") f.client.lock();
    if (interruption === "close") f.close();
    if (interruption === "expiry") f.state.now += 300000;
    resume.finish();
    await finished.promise;
    const [outcome] = await result;
    expect(commits).toBe(interruption === "none" ? 1 : 0);
    expect(outcome?.status).toBe(
      interruption === "none" ? "fulfilled" : "rejected",
    );
  }
});

it("rejects a policy change during the initial authorization before invoking privileged management", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  const revision = deferred<string>();
  f.blockNextRevision(revision.promise);
  let commits = 0;
  f.performManagement(async (check) => {
    check();
    commits += 1;
    return JSON.stringify({ committed: true });
  });
  const pending = f.client.manage({ verb: "receiver-status" }, "owner-current");
  const denied = expect(pending).rejects.toThrow("Owner management failed");
  f.state.revision = "peer-changed-policy";
  revision.finish(f.state.revision);
  await denied;
  expect(f.managementCalls()).toBe(0);
  expect(commits).toBe(0);
});

it("permits only one privileged management callback while an earlier callback is awaiting commit", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  const resume = deferred<void>();
  let commits = 0;
  f.performManagement(async (check) => {
    await resume.promise;
    check();
    commits += 1;
    return JSON.stringify({ committed: true });
  });
  const first = f.client.manage({ verb: "receiver-status" }, "owner-current");
  await f.started;
  await expect(
    f.client.manage({ verb: "receiver-status" }, "owner-current"),
  ).rejects.toThrow("Owner management failed");
  expect(f.managementCalls()).toBe(1);
  expect(commits).toBe(0);
  resume.finish();
  await expect(first).resolves.toContain("committed");
  expect(commits).toBe(1);
});

it("revokes a blocked callback's original lease through real reauthentication and ABA without revoking its successor", async () => {
  for (const lockFirst of [false, true]) {
    const f = managementBridge();
    await f.client.unlock("owner-current");
    const original = f.client.permit();
    const resume = deferred<void>();
    const finished = deferred<void>();
    let commits = 0;
    f.performManagement(async (check) => {
      await resume.promise;
      try {
        check();
        commits += 1;
        return JSON.stringify({ committed: true });
      } finally {
        finished.finish();
      }
    });
    const old = Promise.allSettled([
      f.client.manage({ verb: "receiver-status" }, "owner-current"),
    ]);
    await f.started;
    if (lockFirst) f.client.lock();
    await expect(f.client.unlock("owner-current")).resolves.toMatchObject({
      realm: "real",
    });
    const successor = f.client.permit();
    expect(successor).toBeDefined();
    expect(successor).not.toBe(original);
    resume.finish();
    await finished.promise;
    expect((await old)[0]?.status).toBe("rejected");
    expect(commits).toBe(0);
    expect(f.client.permit()).toBe(successor);
    await expect(f.client.authorize()).resolves.toBe(true);
    await expect(
      f.client.manage({ verb: "receiver-status" }, "owner-current"),
    ).resolves.toContain("committed");
    expect(commits).toBe(1);
    expect(f.client.permit()).toBe(successor);
  }
});

it("never forwards a newly entered management password after its actual runtime port disconnects", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  f.close();
  const sent = f.sent.length;
  const attempted = f.attemptedPosts();
  const privateInput = crypto.randomUUID();
  await expect(
    f.client.manage({ verb: "receiver-test" }, privateInput),
  ).rejects.toThrow();
  expect(f.sent).toHaveLength(sent);
  expect(f.attemptedPosts()).toBe(attempted);
  expect(JSON.stringify(f.sent)).not.toContain(privateInput);
  expect(f.client.permit()).toBeUndefined();
  expect(f.managementCalls()).toBe(0);
});

it("releases global management capacity after an awaited owner callback fails", async () => {
  const f = managementBridge();
  await f.client.unlock("owner-current");
  const other = f.openWorkerPort();
  const peer = await other.handle({
    id: 10,
    op: "unlock",
    password: "owner-current",
  });
  if (!peer.permit)
    throw new Error("Expected a real worker-issued peer permit");
  const resume = deferred<void>();
  let commits = 0;
  f.performManagement(async (check) => {
    await resume.promise;
    check();
    throw new Error("Owner storage transaction refused");
  });
  const first = f.client.manage({ verb: "canary-status" }, "owner-current");
  const refused = expect(first).rejects.toThrow();
  await f.started;
  const peerRequest = {
    id: 11,
    op: "manage" as const,
    permit: peer.permit,
    password: "owner-current",
    operation: { verb: "canary-status" as const },
  };
  await expect(other.handle(peerRequest)).resolves.toMatchObject({
    realm: "locked",
  });
  expect(f.managementCalls()).toBe(1);
  expect(commits).toBe(0);
  resume.finish();
  await refused;
  f.performManagement(async (check) => {
    check();
    commits += 1;
    return JSON.stringify({ committed: true });
  });
  await expect(other.handle({ ...peerRequest, id: 12 })).resolves.toMatchObject(
    {
      realm: "real",
      resultJson: '{"committed":true}',
    },
  );
  expect(commits).toBe(1);
  expect(f.managementCalls()).toBe(2);
  await expect(f.client.authorize()).resolves.toBe(true);
});
