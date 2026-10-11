import { name } from "@gdp-ts/core";
import { sha256Base64Url } from "@opensesame/sdk-browser";
import { describe, expect, it } from "vitest";
import { baseDraft } from "../model-keys/harness.test-support.js";
import { modelGrantDigest } from "../model-keys/root.js";
import {
  type ModelGrantApprovalEvidence,
  proveModelGrantApproved,
} from "./model-grant-approval.js";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

async function evidence(
  overrides: Partial<ModelGrantApprovalEvidence> = {},
  draft = baseDraft(null),
): Promise<ModelGrantApprovalEvidence> {
  return {
    approverPrincipalId: draft.issuerPrincipalId,
    method: "passkey",
    authenticatedAt: NOW - 30_000,
    approvedAt: NOW - 5_000,
    boundDigest: await modelGrantDigest(draft, sha256Base64Url),
    ...overrides,
  };
}

/** What a test may keep of a verdict: plain data, never a proof that mentions a name. */
const prove = (proof: ModelGrantApprovalEvidence, draft = baseDraft(null)) =>
  name(draft, async (named) => {
    const verdict = await proveModelGrantApproved(
      named,
      proof,
      NOW,
      sha256Base64Url,
    );
    return verdict.ok
      ? { ok: true as const, kind: verdict.proof.kind }
      : { ok: false as const, code: verdict.code };
  });

describe("proving a person approved a model grant", () => {
  it("accepts the issuer's fresh passkey approval of this exact draft", async () => {
    expect(await prove(await evidence())).toEqual({
      ok: true,
      kind: "ModelGrantApproved",
    });
  });

  it("refuses an approval by anyone but the person the grant answers to", async () => {
    const verdict = await prove(
      await evidence({ approverPrincipalId: "agent-7" }),
    );
    expect(verdict).toMatchObject({ ok: false, code: "not_the_issuer" });
  });

  it("accepts a passkey or the custodian, and nothing else", async () => {
    expect(await prove(await evidence({ method: "custodian" }))).toEqual({
      ok: true,
      kind: "ModelGrantApproved",
    });
    for (const method of ["password", "pin", "agent", "", "PASSKEY"]) {
      /* SAFETY: each method is deliberately outside the evidence contract's "passkey" | "custodian" union; the runtime prover must refuse it. */
      const weak = method as ModelGrantApprovalEvidence["method"];
      expect(await prove(await evidence({ method: weak }))).toMatchObject({
        ok: false,
        code: "weak_method",
      });
    }
  });

  it("refuses an approval that is old, from the future, or out of order", async () => {
    for (const stale of [
      { authenticatedAt: NOW - 6 * 60_000 },
      { approvedAt: NOW - 6 * 60_000, authenticatedAt: NOW - 7 * 60_000 },
      { approvedAt: NOW + 60_000 },
      { authenticatedAt: NOW + 60_000, approvedAt: NOW + 60_000 },
      { approvedAt: NOW - 20_000, authenticatedAt: NOW - 10_000 },
      { authenticatedAt: Number.NaN },
      { approvedAt: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        await prove(await evidence(stale)),
        JSON.stringify(stale),
      ).toMatchObject({ ok: false, code: "stale" });
    }
    // five minutes exactly is still fresh; a second more is not
    expect(
      (
        await prove(
          await evidence({
            authenticatedAt: NOW - 300_000,
            approvedAt: NOW - 300_000,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await prove(
          await evidence({
            authenticatedAt: NOW - 300_001,
            approvedAt: NOW - 300_001,
          }),
        )
      ).ok,
    ).toBe(false);
  });

  it("refuses an approval of a different grant, however small the difference", async () => {
    const approved = baseDraft(null);
    const shown = await evidence({}, approved);
    for (const changed of [
      { models: [...approved.models, "o1"] },
      { models: ["*"] },
      { clientId: "app-2" },
      { connectionId: "conn-other-openai" },
      { resource: "https://api.anthropic.com/v1" },
      {
        budget: { ...approved.budget, requests: approved.budget.requests + 1 },
      },
      {
        budget: {
          ...approved.budget,
          max_output_tokens: approved.budget.max_output_tokens + 1,
        },
      },
      { lifetimeSeconds: approved.lifetimeSeconds + 1 },
      { maximumDelegationDepth: approved.maximumDelegationDepth + 1 },
      { dpopJkt: "A".repeat(43) },
      { actions: ["model.invoke"] as const },
      { organizationId: "org-2" },
    ]) {
      const verdict = await prove(shown, { ...approved, ...changed });
      expect(verdict, JSON.stringify(changed)).toMatchObject({
        ok: false,
        code: "digest_mismatch",
      });
    }
  });

  it("does not care in what order a draft's lists were written", async () => {
    const approved = baseDraft(null, {
      models: ["gpt-4o", "gpt-4o-mini"],
      actions: ["model.invoke", "model.list"],
    });
    const reordered = {
      ...approved,
      models: ["gpt-4o-mini", "gpt-4o"],
      actions: ["model.list", "model.invoke"] as const,
    };
    expect((await prove(await evidence({}, approved), reordered)).ok).toBe(
      true,
    );
  });
});
