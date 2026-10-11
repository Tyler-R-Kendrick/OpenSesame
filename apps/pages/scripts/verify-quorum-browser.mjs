/**
 * Trusted contacts through a real browser's WebAuthn stack (ADR 0187).
 *
 * Five people, five Chromium contexts, five CDP virtual authenticators that do
 * the PRF extension, the real desk in each page over `navigator.credentials`,
 * and nothing between them but packet strings. It runs a 2-of-3 recovery to the
 * recovered payload, and then the refusals a browser's own stack makes
 * possible: a key that does no PRF, a key that no longer proves the user, a
 * page on the wrong origin, a key that is not the one enrolled.
 *
 * What it does not prove: a physical security key. A virtual authenticator runs
 * the browser's WebAuthn code but not a vendor's firmware, so a YubiKey's PRF
 * (hmac-secret), a platform passkey's PRF and Safari's or Firefox's stacks
 * still need the hardware pass in docs/validation/trusted-contacts-hardware.md.
 */

import assert from "node:assert/strict";
import { ORIGIN, launch, person } from "./lib/quorum-browser-rig.mjs";

const PAYLOAD = {
  v: 1,
  items: [{ id: "bank", name: "Bank", secret: "correct horse battery staple" }],
};
const HOUR = 3600 * 1000;

const steps = [];
async function step(name, run) {
  const started = Date.now();
  process.stdout.write(`  ${name} ... `);
  try {
    await run();
    steps.push({ name, ok: true });
    console.log(`ok (${Date.now() - started} ms)`);
  } catch (error) {
    steps.push({ name, ok: false });
    console.log("FAILED");
    console.error(error);
  }
}

/** Invite, enroll, make the circle, deal the shares and collect the receipts. */
async function armedCircle(
  browser,
  { recovers = true, names = ["Ada", "Ben", "Cy"] } = {},
) {
  const owner = await person(browser, "Owner");
  const guardians = new Map();
  for (const name of names) guardians.set(name, await person(browser, name));
  const { draft, invite } = await owner.run("beginCircle", {
    label: "Family",
    collection: "Emergency",
    recovers,
  });
  const ids = [];
  for (const [name, who] of guardians) {
    const { enrollment } = await who.run("acceptInvitation", {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    const guardian = await owner.run("acceptGuardian", draft.circleId, {
      packet: enrollment,
      custodyDomain: `home-${name}`,
      contactRef: null,
    });
    ids.push(guardian.id);
  }
  const dealt = await owner.run("createFromDraft", draft.circleId, {
    rule: {
      groups: [{ id: "all", threshold: 2, guardianIds: ids }],
      groupThreshold: 1,
    },
    timing: {
      approvalWindowSec: 600,
      releaseDelaySec: 24 * 3600,
      requestLifetimeSec: 7 * 86400,
      requireUserVerification: true,
    },
    payload: recovers ? PAYLOAD : undefined,
  });
  for (const welcome of dealt.welcomes) {
    const who = guardians.get(welcome.name);
    const taken = await who.run("takeWelcome", welcome.packet);
    if (taken.receipt)
      await owner.run("recordReceipt", draft.circleId, taken.receipt);
  }
  return { owner, guardians, draft, dealt, ids };
}

const browser = await launch();
console.log(`Chromium ${browser.version()} on ${ORIGIN}`);
const everyone = [];
const track = (...people) => {
  everyone.push(...people);
};

try {
  await step(
    "2 of 3 recover the payload with real WebAuthn and PRF",
    async () => {
      const { owner, guardians, draft, dealt } = await armedCircle(browser);
      track(owner, ...guardians.values());
      const custody = await owner.run("custodyStatus", draft.circleId);
      assert.equal(custody.armed, true);
      assert.equal(custody.held.length, 3);

      const recipient = await person(browser, "Recipient");
      track(recipient);
      const started = await recipient.run("startRecoveryFlow", {
        bundleText: dealt.bundleFile,
        recipientLabel: "New laptop",
      });
      for (const name of ["Ada", "Cy"]) {
        const approval = await guardians
          .get(name)
          .run("approveRequest", started.request);
        const { outcomes } = await recipient.run(
          "ingest",
          started.requestId,
          approval,
        );
        assert.deepEqual(outcomes, [{ ok: true }]);
      }
      // The delay is kept on each guardian's device: pass it on every clock.
      for (const who of [recipient, ...guardians.values()])
        await who.skew(24 * HOUR + 1000);
      const approvals = await recipient.run(
        "approvalsPacket",
        started.requestId,
      );
      for (const name of ["Ada", "Cy"]) {
        const release = await guardians
          .get(name)
          .run("releaseShare", { request: started.request, approvals });
        await recipient.run("ingest", started.requestId, release);
      }
      assert.deepEqual(
        await recipient.run("openRecovery", started.requestId),
        PAYLOAD,
      );
    },
  );

  await step(
    "a guardian's device refuses to release before the delay, whatever the ledger says",
    async () => {
      const { guardians, dealt } = await armedCircle(browser);
      track(...guardians.values());
      const recipient = await person(browser, "Recipient");
      track(recipient);
      const started = await recipient.run("startRecoveryFlow", {
        bundleText: dealt.bundleFile,
        recipientLabel: "New laptop",
      });
      for (const name of ["Ada", "Cy"]) {
        await recipient.run(
          "ingest",
          started.requestId,
          await guardians.get(name).run("approveRequest", started.request),
        );
      }
      const approvals = await recipient.run(
        "approvalsPacket",
        started.requestId,
      );
      const early = await guardians
        .get("Ada")
        .attempt("releaseShare", { request: started.request, approvals });
      assert.equal(early.ok, false);
      assert.equal(early.code, "too_early");
    },
  );

  await step(
    "a key that does no PRF cannot be part of a circle that holds shares",
    async () => {
      const owner = await person(browser, "Owner");
      const dee = await person(browser, "Dee", { prf: false });
      track(owner, dee);
      const { draft, invite } = await owner.run("beginCircle", {
        label: "Family",
        collection: "Emergency",
        recovers: true,
      });
      const { enrollment } = await dee.run("acceptInvitation", {
        packet: invite,
        name: "Dee",
        keyLabels: ["Security key"],
      });
      const guardian = await owner.run("acceptGuardian", draft.circleId, {
        packet: enrollment,
        custodyDomain: "home",
        contactRef: null,
      });
      const made = await owner.attempt("createFromDraft", draft.circleId, {
        rule: {
          groups: [{ id: "all", threshold: 1, guardianIds: [guardian.id] }],
          groupThreshold: 1,
        },
        timing: {
          approvalWindowSec: 600,
          releaseDelaySec: 3600,
          requestLifetimeSec: 86400,
          requireUserVerification: true,
        },
        payload: PAYLOAD,
      });
      assert.equal(made.ok, false);
      assert.equal(made.code, "no_prf");
    },
  );

  await step(
    "the same key can approve in a circle that only authorizes actions",
    async () => {
      const { owner, guardians, draft, ids } = await armedCircle(browser, {
        recovers: false,
        names: ["Dee", "Eli"],
      });
      track(owner, ...guardians.values());
      assert.equal(ids.length, 2);
      const asked = await owner.run("askToShare", draft.circleId, {
        principalId: "friend",
        resourceKind: "item",
        resourceId: "bank-login",
        resourceLabel: "Bank login",
        policy: "read",
        durationSeconds: 3600,
      });
      for (const [, who] of guardians) {
        const approval = await who.run("approveRequest", asked.packet);
        const { outcomes } = await owner.run(
          "collectApprovals",
          asked.digest,
          approval,
        );
        assert.deepEqual(outcomes, [{ ok: true }]);
      }
    },
  );

  await step("a key that no longer proves the user is refused", async () => {
    const owner = await person(browser, "Owner");
    const ada = await person(browser, "Ada");
    track(owner, ada);
    const { invite } = await owner.run("beginCircle", {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    await ada.userVerified(false);
    const refused = await ada.attempt("acceptInvitation", {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    assert.equal(refused.ok, false);
    // The browser's own refusal, not something this code made up.
    assert.equal(refused.name, "NotAllowedError");
  });

  await step(
    "a page on another origin will not take an invitation, and touches no key",
    async () => {
      const owner = await person(browser, "Owner");
      const phisher = await person(browser, "Phisher", {
        origin: "https://evil.example.test",
      });
      track(owner, phisher);
      const { invite } = await owner.run("beginCircle", {
        label: "Family",
        collection: "Emergency",
        recovers: true,
      });
      const refused = await phisher.attempt("acceptInvitation", {
        packet: invite,
        name: "Ada",
        keyLabels: ["Security key"],
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "origin");
    },
  );

  await step(
    "a different key than the one enrolled cannot approve",
    async () => {
      const { guardians, dealt } = await armedCircle(browser);
      track(...guardians.values());
      const recipient = await person(browser, "Recipient");
      track(recipient);
      const started = await recipient.run("startRecoveryFlow", {
        bundleText: dealt.bundleFile,
        recipientLabel: "New laptop",
      });
      const ada = guardians.get("Ada");
      await ada.replaceKey();
      const refused = await ada.attempt("approveRequest", started.request);
      assert.equal(refused.ok, false);
      assert.equal(refused.name, "NotAllowedError");
    },
  );

  const pageErrors = everyone.flatMap((who) => who.failures ?? []);
  assert.deepEqual(pageErrors, [], "no page raised an error");
} finally {
  await Promise.all(everyone.map((who) => who.close().catch(() => undefined)));
  await browser.close();
}

const failed = steps.filter((s) => !s.ok);
console.log(
  `\n${steps.length - failed.length}/${steps.length} scenarios passed`,
);
if (failed.length > 0) {
  console.error(`Failed: ${failed.map((s) => s.name).join("; ")}`);
  process.exit(1);
}
