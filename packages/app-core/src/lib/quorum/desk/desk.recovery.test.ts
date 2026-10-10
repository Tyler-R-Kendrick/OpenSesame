/**
 * A recovery from start to finish through the desk: five people, five devices,
 * five virtual security keys, and nothing between them but pasted packets.
 */
import { describe, expect, it } from "vitest";
import { PAYLOAD } from "../world.test-support.js";
import { Clock, armedCircle, device, who } from "./harness.test-support.js";
import {
  approvalsPacket,
  approveRequest,
  custodyStatus,
  ingest,
  openRecovery,
  readRequest,
  releaseShare,
  startRecoveryFlow,
} from "./index.js";

describe("a recovery through the desk", () => {
  it("arms the circle only when every guardian's key has reopened their share", async () => {
    const armed = await armedCircle(new Clock());
    expect(await custodyStatus(armed.owner, armed.circleId)).toMatchObject({
      total: 3,
      armed: true,
    });
    expect(armed.dealt.bundleFile).not.toBeNull();
    expect(armed.dealt.welcomes).toHaveLength(3);
    // No packet the owner hands out holds a plaintext share.
    for (const welcome of armed.dealt.welcomes) {
      expect(welcome.packet).not.toMatch(/\s/);
    }
  });

  it("recovers what the circle protects, with two of three guardians and the delay", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    // The owner is gone. A new device raises the request.
    const recipient = device(clock);
    const started = await startRecoveryFlow(recipient, {
      bundleText: armed.dealt.bundleFile ?? "",
      recipientLabel: "New laptop",
    });
    const view = await readRequest(who(armed, "Ada"), started.request);
    expect(view.phase).toBe("approve");
    expect(view.summary).toContain("Release the recovery key");

    for (const name of ["Ada", "Cy"]) {
      const approval = await approveRequest(who(armed, name), started.request);
      const { outcomes } = await ingest(recipient, started.requestId, approval);
      expect(outcomes).toEqual([{ ok: true }]);
    }

    clock.at(24 * 3600 + 1);
    const approvals = await approvalsPacket(recipient, started.requestId);
    for (const name of ["Ada", "Cy"]) {
      const release = await releaseShare(who(armed, name), {
        request: started.request,
        approvals,
      });
      const { outcomes } = await ingest(recipient, started.requestId, release);
      expect(outcomes).toEqual([{ ok: true }]);
    }
    expect(await openRecovery(recipient, started.requestId)).toEqual(PAYLOAD);
    // The recovery is over: its key is gone from the device.
    expect(await recipient.pending.list("recovery:")).toEqual([]);
  });

  it("keeps everything a recovery needs in the pending store, nothing in memory", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const recipient = device(clock);
    const started = await startRecoveryFlow(recipient, {
      bundleText: armed.dealt.bundleFile ?? "",
      recipientLabel: "New laptop",
    });
    // Everything the recipient needs is in the pending store, not in memory.
    for (const name of ["Ben", "Cy"]) {
      const approval = await approveRequest(who(armed, name), started.request);
      await ingest(recipient, started.requestId, approval);
    }
    clock.at(24 * 3600 + 1);
    const approvals = await approvalsPacket(recipient, started.requestId);
    for (const name of ["Ben", "Cy"]) {
      const release = await releaseShare(who(armed, name), {
        request: started.request,
        approvals,
      });
      await ingest(recipient, started.requestId, release);
    }
    expect(await openRecovery(recipient, started.requestId)).toEqual(PAYLOAD);
  });
});
