import { afterEach, beforeEach, expect, it } from "vitest";
import { requiresFreshOwnerAuthentication } from "../decoy-session.js";
import { deviceVaultView } from "../device-identity-vault.js";
import { openDrop } from "./drop.js";
import {
  claimBody,
  createClaimAuthorityFixture,
  holdClaimDigest,
} from "./local-drop-claims-authority.test-support.js";
import {
  createLocalDropClaim,
  pollLocalDropClaim,
  presentLocalDropClaim,
} from "./local-drop-claims.js";

let harness: Awaited<ReturnType<typeof createClaimAuthorityFixture>>;
beforeEach(async () => {
  harness = await createClaimAuthorityFixture();
});
afterEach(async () => {
  await harness.restore();
});

it("preserves the same real encrypted claim across owner and ordinary locked routes", async () => {
  expect(deviceVaultView()).toMatchObject({ kind: "unlocked", guest: false });
  expect(await claimBody(await harness.poll())).toMatchObject({
    status: "pending",
  });
  const before = await harness.state();
  harness.fixture.store.lock();
  expect(deviceVaultView()).toEqual({ kind: "locked" });
  expect(requiresFreshOwnerAuthentication()).toBe(false);
  const poll = await harness.poll();
  expect(poll.status).toBe(200);
  expect(await claimBody(poll)).toMatchObject({ status: "pending" });
  expect(await harness.state()).toEqual(before);
  const create = await harness.create();
  expect(create.status).toBe(423);
  expect(await claimBody(create)).toMatchObject({ error: "locked" });
  const present = await harness.present();
  expect(present.status).toBe(200);
  const body = await claimBody(present);
  expect(body.targetManifest).toEqual(harness.sealed.manifest);
  await expect(
    openDrop(body.targetManifest, harness.sealed.fragmentKey),
  ).resolves.toMatchObject({
    kind: "text",
    text: "owner claim payload",
  });
  expect(await claimBody(await harness.poll())).toMatchObject({
    status: "consumed",
  });
});

type Operation = "create" | "present" | "wrong-code" | "poll";
type Surface = "route" | "local";
function invoke(surface: Surface, operation: Operation): Promise<unknown> {
  const { claim, sealed } = harness;
  const code = operation === "wrong-code" ? "WRONG-CODE" : claim.userCode;
  if (surface === "route") {
    if (operation === "create") return harness.create();
    if (operation === "poll") return harness.poll();
    return harness.present(code);
  }
  if (operation === "create")
    return createLocalDropClaim(sealed.manifest, 600_000);
  if (operation === "poll")
    return pollLocalDropClaim(claim.claimId, claim.claimToken);
  return presentLocalDropClaim(claim.claimToken, code);
}

const HELD_CASES: Array<[Surface, Operation, "token" | "code"]> = [
  ["route", "create", "code"],
  ["local", "create", "token"],
  ["route", "present", "code"],
  ["local", "present", "token"],
  ["route", "wrong-code", "code"],
  ["local", "wrong-code", "code"],
  ["route", "poll", "token"],
  ["local", "poll", "token"],
];

it.each(HELD_CASES)(
  "withholds %s %s state and output after its genuine %s digest crosses synthetic and fresh owner authentication",
  async (surface, operation, digest) => {
    const hold = holdClaimDigest(digest);
    let returned: unknown;
    const result = invoke(surface, operation).then(
      (value) => {
        returned = value;
        return null;
      },
      (error: Error) => error,
    );
    try {
      await hold.reached;
      const before = await harness.state();
      await harness.synthetic();
      await harness.freshOwner();
      hold.release();
      expect(await result).toBeInstanceOf(Error);
      expect(returned).toBeUndefined();
      // Production KV and persisted ciphertext bytes in the in-memory OPFS API double.
      expect(await harness.state()).toEqual(before);
    } finally {
      hold.release();
      await result;
      hold.restore();
    }
    // A fresh operation may use that still-pending claim after the old operation retires.
    const poll = await harness.poll();
    expect(poll.status).toBe(200);
    expect(await claimBody(poll)).toMatchObject({ status: "pending" });
    const present = await harness.present();
    expect(present.status).toBe(200);
    const body = await claimBody(present);
    expect(body.targetManifest).toEqual(harness.sealed.manifest);
    await expect(
      openDrop(body.targetManifest, harness.sealed.fragmentKey),
    ).resolves.toMatchObject({ text: "owner claim payload" });
    expect(await claimBody(await harness.poll())).toMatchObject({
      status: "consumed",
    });
  },
);

it("refuses all direct local claim ports during synthetic presentation and its locked owner-proof latch", async () => {
  const before = await harness.state();
  await harness.synthetic();
  for (const operation of [
    "create",
    "present",
    "wrong-code",
    "poll",
  ] as const) {
    await expect(invoke("local", operation)).rejects.toThrow(
      /authenticate again/,
    );
  }
  harness.fixture.store.lock();
  expect(deviceVaultView()).toEqual({ kind: "locked" });
  expect(requiresFreshOwnerAuthentication()).toBe(true);
  for (const operation of [
    "create",
    "present",
    "wrong-code",
    "poll",
  ] as const) {
    await expect(invoke("local", operation)).rejects.toThrow(
      /authenticate again/,
    );
  }
  expect(await harness.state()).toEqual(before);
  await harness.freshOwner();
  const present = await harness.present();
  expect(present.status).toBe(200);
  expect(await claimBody(present)).toMatchObject({
    status: "consumed",
    targetManifest: harness.sealed.manifest,
  });
});
