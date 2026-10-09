import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvGet } from "../kv.js";
import { sealDrop } from "./drop.js";
import {
  LOCAL_DROP_CLAIM_STORAGE_KEY,
  createLocalDropClaim,
  localDropClaimSeams,
  pagesClaimBase,
  pagesClaimUrl,
  pollLocalDropClaim,
  presentLocalDropClaim,
  resetLocalDropClaimsForTests,
  revokeLocalDropClaim,
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

    const raw = kvGet(LOCAL_DROP_CLAIM_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed: unknown = JSON.parse(String(raw));
    expect(parsed).toMatchObject({
      claims: {
        [session.claimId]: { targetManifest: {} },
      },
    });
  });

  it("revokes a pending claim and refuses presentation afterward", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "revoke-me",
      text: "gone",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    await revokeLocalDropClaim(session.claimId, session.bearerToken);
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("expired");
    await expect(
      presentLocalDropClaim(session.bearerToken, session.userCode),
    ).rejects.toThrow(/expired/i);
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
    ).rejects.toThrow(/does not match this drop\. 4 tries left\./);
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("pending");
    const presented = await presentLocalDropClaim(
      session.bearerToken,
      session.userCode,
    );
    expect(presented.state).toBe("consumed");
  });

  it("counts the tries left and warns before the last one is spent", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "api-token",
      text: "s3cr3t",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    const wrong = (attemptsLeft: number, message: string) =>
      expect(
        presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
      ).rejects.toMatchObject({
        wire: "invalid_user_code",
        attemptsLeft,
        message,
      });
    await wrong(4, "That code does not match this drop. 4 tries left.");
    await wrong(3, "That code does not match this drop. 3 tries left.");
    await wrong(2, "That code does not match this drop. 2 tries left.");
    await wrong(
      1,
      "That code does not match this drop. This is your last try.",
    );
    await wrong(0, "That code does not match this drop. No tries left.");
    await expect(
      presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
    ).rejects.toThrow(/Too many wrong codes/);
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("pending");
  });
});
