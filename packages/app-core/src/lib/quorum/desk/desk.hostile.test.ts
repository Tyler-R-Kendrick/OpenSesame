/**
 * What the desk does with a paste it should not trust: the wrong packet in the
 * wrong box, somebody else's circle, a cancellation nobody signed, and a page
 * on the wrong origin. Each test changes one thing and pins one refusal.
 */
import { describe, expect, it } from "vitest";
import { signCancellation } from "../cancellation.js";
import { generateOwnerKeys } from "../circle.js";
import { EnrollmentError } from "../enroll.js";
import { encodePacket } from "../packets.js";
import { requestDigest } from "../request.js";
import { Clock, armedCircle, device, who } from "./harness.test-support.js";
import {
  DEFAULT_TIMING,
  DeskError,
  acceptGuardian,
  acceptInvitation,
  approveRequest,
  beginCircle,
  cancelRequest,
  draftForPreview,
  ingest,
  noteCancellation,
  previewCircle,
  readDraft,
  readInvitation,
  readRequest,
  startRecoveryFlow,
  takeWelcome,
} from "./index.js";

async function started(clock: Clock) {
  const armed = await armedCircle(clock);
  const recipient = device(clock);
  const run = await startRecoveryFlow(recipient, {
    bundleText: armed.dealt.bundleFile ?? "",
    recipientLabel: "New laptop",
  });
  return { armed, recipient, run };
}

describe("a paste the desk should not trust", () => {
  it("will not let a stranger's welcome in: only an invitation this device accepted opens a circle", async () => {
    const clock = new Clock();
    const a = await armedCircle(clock);
    const b = await armedCircle(clock);
    const welcomeFromB = b.dealt.welcomes[0];
    if (!welcomeFromB) throw new Error("no welcome");
    await expect(
      takeWelcome(who(a, "Ada"), welcomeFromB.packet),
    ).rejects.toMatchObject({ code: "no_invitation" });
    // And nothing was saved by trying.
    expect(await who(a, "Ada").records.held()).toHaveLength(1);
  });

  it("names the wrong kind of packet instead of guessing", async () => {
    const clock = new Clock();
    const { armed, recipient, run } = await started(clock);
    await expect(takeWelcome(who(armed, "Ada"), run.request)).rejects.toThrow(
      /is a request, not a welcome|not a welcome/,
    );
    // A request pasted where an approval goes.
    await expect(
      ingest(recipient, run.requestId, run.request),
    ).rejects.toMatchObject({ code: "kind" });
    await expect(
      ingest(recipient, run.requestId, "not a packet"),
    ).rejects.toThrow(/not a packet/);
  });

  it("reads a request only against a circle this device holds", async () => {
    const clock = new Clock();
    const { run } = await started(clock);
    const stranger = device(clock);
    await expect(readRequest(stranger, run.request)).rejects.toMatchObject({
      code: "not_held",
    });
  });

  it("will not take an approval for a different request", async () => {
    const clock = new Clock();
    const one = await started(clock);
    const two = await started(clock);
    const approval = await approveRequest(
      who(one.armed, "Ada"),
      one.run.request,
    );
    const { outcomes } = await ingest(
      two.recipient,
      two.run.requestId,
      approval,
    );
    expect(outcomes[0]).toMatchObject({ ok: false });
  });

  it("stops a guardian approving once the owner's cancellation has reached their device", async () => {
    const clock = new Clock();
    const { armed, run } = await started(clock);
    const cancelled = await cancelRequest(
      armed.owner,
      armed.circleId,
      run.request,
    );
    const ada = who(armed, "Ada");
    expect((await readRequest(ada, run.request)).phase).toBe("approve");
    await noteCancellation(ada, cancelled.packet);
    expect((await readRequest(ada, run.request)).phase).toBe("cancelled");
    await expect(approveRequest(ada, run.request)).rejects.toMatchObject({
      code: "cancelled",
    });
    // Ben was not told; his device still approves. A cancellation reaches only who hears of it.
    const approval = await approveRequest(who(armed, "Ben"), run.request);
    expect(approval).toMatch(/^osq1\.approval\./);
  });

  it("refuses a cancellation the owner did not sign", async () => {
    const clock = new Clock();
    const { armed, run } = await started(clock);
    const view = await readRequest(who(armed, "Ada"), run.request);
    const forged = signCancellation({
      circleId: armed.circleId,
      requestDigest: view.digest,
      ownerSecretKey: generateOwnerKeys().secretKey,
      now: clock.date(),
    });
    await expect(
      noteCancellation(
        who(armed, "Ada"),
        encodePacket({ kind: "cancellation", value: forged }),
      ),
    ).rejects.toMatchObject({ code: "bad_signature" });
    expect((await readRequest(who(armed, "Ada"), run.request)).phase).toBe(
      "approve",
    );
  });

  it("refuses an invitation on a page the circle does not accept, before any key is touched", async () => {
    const clock = new Clock();
    const owner = device(clock);
    const { invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const phisher = device(clock, { origin: "https://evil.example.test" });
    expect(readInvitation(phisher, invite).originOk).toBe(false);
    await expect(
      acceptInvitation(phisher, {
        packet: invite,
        name: "Ada",
        keyLabels: ["Security key"],
      }),
    ).rejects.toBeInstanceOf(EnrollmentError);
    expect(await phisher.pending.list("guardian-pending:")).toEqual([]);
  });

  it("will not take the same person twice", async () => {
    const clock = new Clock();
    const owner = device(clock);
    const ada = device(clock);
    const { draft, invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const { enrollment } = await acceptInvitation(ada, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    const input = {
      packet: enrollment,
      custodyDomain: "home",
      contactRef: null,
    };
    await acceptGuardian(owner, draft.circleId, input);
    await expect(
      acceptGuardian(owner, draft.circleId, input),
    ).rejects.toBeInstanceOf(DeskError);
  });

  it("checks the rule before anything is made, and says what is risky but legal", async () => {
    const clock = new Clock();
    const owner = device(clock);
    const ada = device(clock);
    const { draft, invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const { enrollment } = await acceptInvitation(ada, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: "home",
      contactRef: null,
    });
    const current = await readDraft(owner, draft.circleId);
    if (!current) throw new Error("no draft");
    const rule = (threshold: number) => ({
      groups: [{ id: "all", threshold, guardianIds: [guardian.id] }],
      groupThreshold: 1,
    });
    const legal = previewCircle(
      draftForPreview(owner, current, rule(1), DEFAULT_TIMING),
    );
    expect(legal).toMatchObject({ ok: true });
    expect(legal.ok && legal.warnings.map((w) => w.code)).toContain(
      "single_guardian",
    );
    const impossible = previewCircle(
      draftForPreview(owner, current, rule(2), DEFAULT_TIMING),
    );
    expect(impossible).toMatchObject({ ok: false, code: "member_threshold" });
  });

  it("derives the sentence a guardian reads from the request, so a lie in it does not survive", async () => {
    const clock = new Clock();
    const { armed, run } = await started(clock);
    const view = await readRequest(who(armed, "Ada"), run.request);
    expect(view.digest).toBe(
      requestDigest(
        JSON.parse(
          Buffer.from(run.request.split(".")[2] ?? "", "base64url").toString(),
        ),
      ),
    );
    // Rewrite the sentence inside the packet: the desk refuses it.
    const body = JSON.parse(
      Buffer.from(run.request.split(".")[2] ?? "", "base64url").toString(),
    );
    body.summary = "Do something harmless";
    const lie = encodePacket({ kind: "request", value: body });
    await expect(readRequest(who(armed, "Ada"), lie)).rejects.toThrow();
  });
});
