import { name } from "@gdp-ts/core";
import { MemoryRepositories } from "@opensesame/database";
import type { AssuranceLevel } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { actorId } from "../lib/ids.js";
import { verifiedPrincipal } from "../proofs/verified-principal.js";
import { AppClaimService, ClaimError } from "../services/app-claim.js";
import { insertOAuthClient } from "../services/verified-admin.js";
import { startClaimAsVerified } from "./verified-principal-fixture.js";

const NOW = new Date("2026-01-01T00:00:00Z");

async function verdictFor(assurance: AssuranceLevel | undefined) {
  const repos = new MemoryRepositories();
  if (assurance) {
    await repos.principals.create({
      id: "prn_1",
      state: "active",
      assurance,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    });
  }
  return name(actorId("prn_1"), (actor) => verifiedPrincipal(repos, actor));
}

describe("verifiedPrincipal proof", () => {
  it("proves a principal whose assurance is not provisional", async () => {
    const verdict = await verdictFor("verified");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.proof.kind).toBe("VerifiedPrincipal");
  });

  it("refuses a provisional principal, naming why", async () => {
    expect(await verdictFor("provisional")).toEqual({
      ok: false,
      reason: "provisional",
    });
  });

  it("refuses a principal the store does not know, apart from a provisional one", async () => {
    expect(await verdictFor(undefined)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("guarded OAuth client writes", () => {
  it("refuse a client owned by someone other than the proven principal", async () => {
    const { ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    await ctx.repos.principals.create({
      id: "prn_1",
      state: "active",
      assurance: "verified",
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    });
    await name(actorId("prn_1"), async (actor) => {
      const verdict = await verifiedPrincipal(ctx.repos, actor);
      if (!verdict.ok) throw new Error("expected a verified principal");
      expect(() =>
        insertOAuthClient(ctx, actor, verdict.proof, {
          id: "cli_x",
          ownerPrincipalId: "prn_other",
          admissionMode: "pre_registered",
          displayName: "RP",
          redirectUris: ["http://127.0.0.1:5173/callback"],
          sectorIdentifier: "https://rp.example",
          grantTypes: ["authorization_code"],
          responseTypes: ["code"],
          tokenEndpointAuthMethod: "none",
          allowedScopes: [],
          allowedResources: [],
          state: "active",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow("different principal");
    });
  });
});

describe("claiming an application", () => {
  it("is reachable only through a real proof, and a verified owner gets the service's own answer", async () => {
    const { ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const service = new AppClaimService({
      clientStore: ctx.stores.oauthClients,
      challengeStore: ctx.stores.clientClaimChallenges,
      clientOriginStore: ctx.stores.clientOrigins,
      issuer: ctx.config.issuer,
      systemOwnerPrincipalId: ctx.systemOwnerPrincipalId,
      clock: ctx.clock,
      isProduction: false,
      allowDirectFetch: true,
    });
    for (const [id, assurance] of [
      ["prn_v", "verified"],
      ["prn_p", "provisional"],
    ] as const) {
      await ctx.repos.principals.create({
        id,
        state: "active",
        assurance,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
      });
    }
    await expect(
      startClaimAsVerified(ctx, service, "prn_p", "cli_missing"),
    ).rejects.toThrow("not verified: provisional");
    await expect(
      startClaimAsVerified(ctx, service, "prn_v", "cli_missing"),
    ).rejects.toBeInstanceOf(ClaimError);
  });
});
