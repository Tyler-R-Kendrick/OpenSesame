import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { atRestReady } from "../at-rest/key.js";
import { sealOriginFile } from "../at-rest/origin-files.js";
import {
  installOpfs,
  makeOpfs,
} from "../duress/wipe/fake-opfs.test-support.js";
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

  it("re-reads a claim presented by another tab instead of its stale cache", async () => {
    const root = makeOpfs();
    installOpfs(root);
    try {
      const { manifest } = await sealDrop({
        kind: "text",
        name: "cross-tab",
        text: "one use",
      });
      const session = await createLocalDropClaim(manifest, 600_000);
      // This tab still holds the pending copy in its in-memory kv cache.
      const stored = JSON.parse(
        String(kvGet(LOCAL_DROP_CLAIM_STORAGE_KEY)),
      ) as {
        claims: Record<string, { state: string; targetManifest: unknown }>;
      };
      const record = stored.claims[session.claimId];
      if (!record) throw new Error("expected the pending claim");
      record.state = "presented";
      record.targetManifest = {};
      // Another tab commits the presentation durably; this tab's cache does
      // not see `kvSet`, so only a refresh under the claim lock can.
      const name = "opensesame-pages-opensesame.local-drop-claims.v1.json";
      const atRest = await atRestReady();
      root.files.set(
        name,
        sealOriginFile(atRest, name, JSON.stringify(stored)),
      );
      await expect(
        presentLocalDropClaim(session.bearerToken, session.userCode),
      ).rejects.toThrow(/already opened/);
    } finally {
      vi.unstubAllGlobals();
      configureHost(createTestHost());
      resetLocalDropClaimsForTests();
    }
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
    ).resolves.toBe("revoked");
    await expect(
      presentLocalDropClaim(session.bearerToken, session.userCode),
    ).rejects.toThrow(/revoked/i);
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
    await expect(
      presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
    ).rejects.toMatchObject({
      wire: "too_many_attempts",
      message: /Locked out/,
    });
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("locked_out");
  });
});
