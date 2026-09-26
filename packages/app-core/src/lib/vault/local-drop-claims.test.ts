import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealDrop } from "./drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  pagesClaimBase,
  pagesClaimUrl,
  pollLocalDropClaim,
  presentLocalDropClaim,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";

beforeEach(() => {
  resetLocalDropClaimsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

afterEach(() => {
  resetLocalDropClaimsForTests();
  localDropClaimSeams.claimBase = () => pagesClaimBase();
});

describe("pagesClaimBase", () => {
  it("joins origin and Vite base without a trailing slash", () => {
    expect(pagesClaimBase("http://localhost:5180", "/OpenSesame/")).toBe(
      "http://localhost:5180/OpenSesame",
    );
    expect(pagesClaimBase("https://pages.example", "/")).toBe(
      "https://pages.example",
    );
  });

  it("names the spec's /claim route under that base, the one drop link", () => {
    expect(pagesClaimUrl("http://localhost:5180/OpenSesame")).toBe(
      "http://localhost:5180/OpenSesame/claim",
    );
    expect(pagesClaimUrl("https://pages.example")).toBe(
      "https://pages.example/claim",
    );
  });
});

describe("local drop claims — no Identity API", () => {
  it("creates, polls pending, presents once, then reports consumed", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "api-token",
      text: "s3cr3t",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    expect(session.claimId.startsWith("clm_")).toBe(true);
    expect(session.bearerToken.startsWith(`osc_clm_${session.claimId}.`)).toBe(
      true,
    );
    expect(session.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(session.verifyUrl).toBe("http://localhost:5180/OpenSesame/claim");

    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("pending");

    const presented = await presentLocalDropClaim(
      session.bearerToken,
      session.userCode,
    );
    expect(presented.state).toBe("consumed");
    expect(presented.targetManifest).toMatchObject({
      kind: "secret-drop",
      name: "api-token",
    });

    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("consumed");

    await expect(
      presentLocalDropClaim(session.bearerToken, session.userCode),
    ).rejects.toThrow(/already opened/);
  });

  it("refuses a wrong user code without burning the claim", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "api-token",
      text: "s3cr3t",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    await expect(
      presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
    ).rejects.toThrow(/does not match/);
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("pending");
    const presented = await presentLocalDropClaim(
      session.bearerToken,
      session.userCode,
    );
    expect(presented.state).toBe("consumed");
  });
});
