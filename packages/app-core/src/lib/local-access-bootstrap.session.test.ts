/** @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDefaultAccess } from "./local-access-bootstrap.js";
import { readLocalDirectory } from "./local-directory.js";
import { localRequestFixture } from "./local-request.fixture.js";
import {
  currentLocalIdentitySession,
  signInLocalIdentity,
} from "./local-sessions.js";
import { lockAllTombs } from "./vfs.js";

// Every Identity and Access panel runs ensureDefaultAccess when it mounts. A
// directory write ends every local session (ADR 0104, 0105), and a tab that
// signed someone in has no custodian fallback, so a seed that wrote on every
// mount would sign a person out each time they opened Identity.
beforeEach(() => {
  // jsdom's realm differs from Node's TextEncoder/WebCrypto realm.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("leaves a seeded directory and a signed-in person's session alone", async () => {
  const fixture = await localRequestFixture();
  // The fixture's directory lacks the built-in agent and this app: the first
  // seed adds them, which ends the fixture's session as any change does.
  const before = (await readLocalDirectory(fixture.tomb)).revision;
  await ensureDefaultAccess(fixture.tomb);
  const seeded = (await readLocalDirectory(fixture.tomb)).revision;
  expect(seeded).toBeGreaterThan(before);
  expect(
    await currentLocalIdentitySession(fixture.tomb, fixture.personId),
  ).toBeNull();

  const session = await signInLocalIdentity(fixture.tomb, fixture.personId);
  await ensureDefaultAccess(fixture.tomb);
  expect((await readLocalDirectory(fixture.tomb)).revision).toBe(seeded);
  expect(
    await currentLocalIdentitySession(fixture.tomb, fixture.personId),
  ).toBe(session);
});
