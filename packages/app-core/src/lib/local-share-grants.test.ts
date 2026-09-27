/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  createLocalShare,
  listLocalShares,
  listShareTargets,
  revokeLocalShare,
} from "./local-share-grants.js";
import { lockAllTombs, writeFile } from "./vfs.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("grants a vault to a person and lists it until revoked", async () => {
  const fixture = await localRequestFixture();
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "vault",
    resourceId: "personal",
    resourceLabel: "personal",
    policy: "open",
    durationSeconds: 3600,
  });
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceKind).toBe("vault");
  expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  await revokeLocalShare(fixture.tomb, shares[0]?.id ?? "");
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
});

it("grants a connector under the invoke policy", async () => {
  const fixture = await localRequestFixture();
  const github = listShareTargets().find(
    (target) => target.kind === "connection" && target.id === "github",
  );
  if (!github) throw new Error("missing connector");
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: github.id,
    resourceLabel: github.label,
    policy: "invoke",
    durationSeconds: 86400,
  });
  expect(shares[0]?.policy).toBe("invoke");
  expect(shares[0]?.resourceId).toBe("github");
});

/** A trail that refuses every entry: corrupt, so each append fails to read it. */
async function breakAccessTrail(tomb: string): Promise<void> {
  await writeFile(tomb, "config/access-audit", new TextEncoder().encode("{}"));
}

it("a connector grant stands when the trail will not take its entry", async () => {
  const fixture = await localRequestFixture();
  await breakAccessTrail(fixture.tomb);
  const shares = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });
  expect(shares).toHaveLength(1);
  expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
});

it("a connector revoke the trail will not record leaves the share for a retry", async () => {
  const fixture = await localRequestFixture();
  const [share] = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "invoke",
    durationSeconds: 86400,
  });
  if (!share) throw new Error("expected a share");
  await breakAccessTrail(fixture.tomb);
  await expect(revokeLocalShare(fixture.tomb, share.id)).rejects.toThrow(
    /corrupt/,
  );
  expect((await listLocalShares(fixture.tomb)).map((row) => row.id)).toEqual([
    share.id,
  ]);
});
