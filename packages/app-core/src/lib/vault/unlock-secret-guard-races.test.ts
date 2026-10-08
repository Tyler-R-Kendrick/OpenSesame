import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertNotDecoySession } from "../decoy-session.js";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { kvGet } from "../kv.js";
import { retiredCredentialStatus } from "../retired-credentials/index.js";
import { openRetiredCredentialDecoy } from "../retired-credentials/session.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import {
  assertNewPassword,
  assertNewPin,
  withNewPassword,
} from "./unlock-secret-guard.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
  clearActivePresentation();
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["validate", "commit"] as const)(
  "refuses stale %s across a real lock and fresh password unlock after admission",
  async (operation) => {
    const work = vi.fn(async () => "committed");
    const pending =
      operation === "validate"
        ? assertNewPassword(PASSWORD, "personal")
        : withNewPassword(PASSWORD, "personal", work);
    const refused = expect(pending).rejects.toThrow(/authenticate again/);
    fixture.store.lock();
    await fixture.store.unlock(PASSWORD);
    expect(fixture.store.getSnapshot().status).toBe("unlocked");
    await refused;
    expect(work).not.toHaveBeenCalled();
  },
);

it("refuses a late operation result after a real lock and fresh password unlock", async () => {
  const started = deferred();
  const held = deferred();
  const pending = withNewPassword(PASSWORD, "personal", async () => {
    started.release();
    await held.promise;
    return "stale-result";
  });
  const refused = expect(pending).rejects.toThrow(/authenticate again/);
  await started.promise;
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
  held.release();
  await refused;
});

// The existing fixture supplies only physical browser storage/LockManager ports;
// real VaultStore admission, password crypto and trap/decoy constructors run.
const ADMITTED_PIN = "48291073";

it.each(["pin", "validate", "commit"] as const)(
  "admits the current owner through the actual cached %s duress loader",
  async (operation) => {
    await import("../duress/store/duress-code-probe.js");
    const generation = assertNotDecoySession();
    const work = vi.fn(async () => "committed");
    const operations = {
      pin: () => assertNewPin(ADMITTED_PIN),
      validate: () => assertNewPassword(PASSWORD, "personal"),
      commit: () => withNewPassword(PASSWORD, "personal", work),
    };
    const result = await operations[operation]();
    expect(result).toBe(operation === "commit" ? "committed" : undefined);
    expect(work).toHaveBeenCalledTimes(operation === "commit" ? 1 : 0);
    expect(assertNotDecoySession(generation)).toBe(generation);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "unlocked",
      guest: false,
      decoy: false,
    });
  },
);

it.each([
  ["pin", false],
  ["pin", true],
  ["validate", false],
  ["validate", true],
  ["commit", false],
  ["commit", true],
] as const)(
  "retains the original generation through the cached %s duress loader and fresh real recovery (synthetic=%s)",
  async (operation, synthetic) => {
    if (synthetic)
      await fixture.enroll("retired-cold-probe-password", "synthetic_decoy");
    const syntheticTrap = retiredCredentialStatus("personal").traps.find(
      (trap) => trap.response === "synthetic_decoy",
    );
    await import("../duress/store/duress-code-probe.js");
    const generation = assertNotDecoySession();
    const beforeTraps = kvGet(TRAPS_KEY);
    const headerKey = tombFileKey("personal", HEADER_PATH);
    const beforeHeader = kvGet(headerKey);
    expect(beforeHeader).not.toBeNull();
    const work = vi.fn(async () => "committed");
    const operations = {
      pin: () => assertNewPin(ADMITTED_PIN),
      validate: () => assertNewPassword(PASSWORD, "personal"),
      commit: () => withNewPassword(PASSWORD, "personal", work),
    };
    // Even a cached import yields. Retire the genuine owner before it resumes,
    // then return a freshly authenticated owner rather than toggling a flag.
    const pending = operations[operation]().then(
      () => null,
      (error: Error) => error,
    );
    fixture.store.lock();
    if (synthetic) {
      if (!syntheticTrap)
        throw new Error("The genuine synthetic trap must be enrolled.");
      await openRetiredCredentialDecoy(
        fixture.store,
        syntheticTrap,
        "personal",
      );
      expect(fixture.store.getSnapshot()).toMatchObject({
        status: "unlocked",
        guest: true,
        decoy: true,
      });
      fixture.store.lock();
    }
    await fixture.store.unlock(PASSWORD);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/authenticate again/);
    expect(work).not.toHaveBeenCalled();
    expect(() => assertNotDecoySession(generation)).toThrow();
    expect(() => assertNotDecoySession()).not.toThrow();
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "unlocked",
      guest: false,
      decoy: false,
    });
    expect(kvGet(TRAPS_KEY)).toBe(beforeTraps);
    expect(kvGet(headerKey)).toBe(beforeHeader);
    expect(fixture.store.getSnapshot().header?.unlocks?.pin).toBeUndefined();
  },
);
