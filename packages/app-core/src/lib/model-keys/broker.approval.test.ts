import { name } from "@gdp-ts/core";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { describe, expect, it } from "vitest";
import { proveModelGrantApproved } from "../proofs/model-grant-approval.js";
import {
  baseDraft,
  expectRefused,
  harness,
  newSigner,
  wireOf,
} from "./harness.test-support.js";
import { type ModelGrantDraft, modelGrantDigest } from "./root.js";

/** A person approves `draft`; the approval is then spent as many times as `spend` says. */
async function approvedDraft<T>(
  h: ReturnType<typeof harness>,
  draft: ModelGrantDraft,
  spend: (issue: () => ReturnType<typeof h.broker.issueRoot>) => Promise<T>,
): Promise<T> {
  const digest = await modelGrantDigest(draft, sha256Base64Url);
  return name(draft, async (named) => {
    const verdict = await proveModelGrantApproved(
      named,
      {
        approverPrincipalId: draft.issuerPrincipalId,
        method: "passkey",
        authenticatedAt: h.clock.now - 10_000,
        approvedAt: h.clock.now - 1_000,
        boundDigest: digest,
      },
      h.clock.now,
      sha256Base64Url,
    );
    if (!verdict.ok) throw new Error(`approval refused: ${verdict.code}`);
    return spend(() => h.broker.issueRoot(named, verdict.proof));
  });
}

describe("an approval is spent by the key it issues", () => {
  it("mints one root, and refuses the same approval a second time", async () => {
    const h = harness();
    const signer = await newSigner();
    await approvedDraft(h, baseDraft(signer), async (issue) => {
      const first = await issue();
      expect(first.token).toMatch(/^osk_/);
      await expectRefused(issue(), "access_denied", "approval.spent");
    });
    expect(h.broker.list()).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "root.issued")).toHaveLength(1);
  });

  it("refuses ten tries of one approval, even when they race", async () => {
    const h = harness();
    const signer = await newSigner();
    await approvedDraft(h, baseDraft(signer), async (issue) => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () => issue()),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    });
    expect(h.broker.list()).toHaveLength(1);
  });

  it("answers as the neighbouring refusals do, and says why only in the reason", async () => {
    const h = harness();
    const signer = await newSigner();
    const wire = await approvedDraft(h, baseDraft(signer), async (issue) => {
      await issue();
      return wireOf(issue());
    });
    expect(wire).toEqual({
      error: "access_denied",
      error_description: "The request was not approved.",
    });
  });

  it("is not used up by a draft the broker refused, which fails the same way again", async () => {
    const h = harness();
    const signer = await newSigner();
    await approvedDraft(
      h,
      baseDraft(signer, { resource: "https://nowhere.example.test/v1" }),
      async (issue) => {
        await expectRefused(issue(), "invalid_target", "draft.resource");
        await expectRefused(issue(), "invalid_target", "draft.resource");
      },
    );
    expect(h.broker.list()).toHaveLength(0);
  });

  it("does not stop a fresh approval of the same draft", async () => {
    const h = harness();
    const signer = await newSigner();
    const one = await h.root(signer);
    const two = await h.root(signer);
    expect(two.id).not.toBe(one.id);
    expect(two.token).not.toBe(one.token);
    expect(h.broker.list()).toHaveLength(2);
  });

  it("stays spent across a reset, which is a lock and not a new approval", async () => {
    const h = harness();
    const signer = await newSigner();
    await approvedDraft(h, baseDraft(signer), async (issue) => {
      await issue();
      h.broker.reset();
      await expectRefused(issue(), "access_denied", "approval.spent");
    });
    expect(h.broker.list()).toHaveLength(0);
  });
});
