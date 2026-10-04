/**
 * The device's inbox (ADR 0162): what waits for the person, newest first, as
 * the closed contract and nothing a notification could not carry.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listInbox } from "./device-inbox.js";
import {
  createLocalAccessRequest,
  decideLocalAccessRequest,
  revokeLocalAccessRequest,
} from "./local-access-requests.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { lockAllTombs } from "./vfs.js";

type Fixture = Awaited<ReturnType<typeof localRequestFixture>>;
let fx: Fixture;
let clock: number;

/** A second passes: the clock the fixture froze moves on. */
function tick() {
  clock += 1000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
}

function raise(reason: string) {
  return createLocalAccessRequest(fx.tomb, fx.session, {
    applicationId: fx.applicationId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    reason,
  });
}

beforeEach(async () => {
  fx = await localRequestFixture();
  clock = Date.now();
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("is empty when nothing has been asked", async () => {
  expect(await listInbox(fx.tomb)).toEqual([]);
});

it("lists waiting requests newest first, each as kind, action, ref and expiry", async () => {
  const older = await raise("older");
  tick();
  const newer = await raise("newer");
  const rows = await listInbox(fx.tomb);
  expect(rows.map((row) => row.ref)).toEqual([newer.id, older.id]);
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual([
      "action",
      "expiresAt",
      "kind",
      "ref",
    ]);
  expect(rows[0]).toMatchObject({ kind: "local-access", action: "review" });
});

it("drops a request once it is decided, withdrawn or lapsed", async () => {
  const approved = await raise("approve me");
  tick();
  const withdrawn = await raise("withdraw me");
  tick();
  const lapsing = await raise("let me lapse");
  await decideLocalAccessRequest(fx.tomb, {
    ...approved,
    principalId: fx.personId,
    decision: "approve",
  });
  await revokeLocalAccessRequest(fx.tomb, withdrawn);
  expect((await listInbox(fx.tomb)).map((row) => row.ref)).toEqual([
    lapsing.id,
  ]);
  expect(await listInbox(fx.tomb, lapsing.expiresAt)).toEqual([]);
});

it("throws while the vault is shut rather than say nothing is waiting", async () => {
  await raise("waiting");
  lockAllTombs();
  await expect(listInbox(fx.tomb)).rejects.toThrow();
});
