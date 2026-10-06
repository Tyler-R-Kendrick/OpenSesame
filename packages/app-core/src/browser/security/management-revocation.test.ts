import { expect, it } from "vitest";
import { managementBridge } from "./management.fixture.js";

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
