import { afterEach, beforeEach, expect, it } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import { kvGet } from "../kv.js";
import {
  clearRetiredCredentialEvents,
  probeRetiredCredential,
  removeRetiredCredential,
  retiredCredentialStatus,
  retiredCredentialStorageSeams,
} from "./index.js";
import { verifyCurrentCredential } from "./owner-auth.js";
import {
  PASSWORD,
  TRAPS_KEY,
  createRetiredCredentialFixture,
} from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());

it("refuses a password proof across a synthetic round trip and hides the previous owner admission", async () => {
  await expect(
    verifyCurrentCredential("personal", PASSWORD, async () => {
      markDecoySession(true);
      markDecoySession(false);
    }),
  ).rejects.toThrow(/authenticate again/);
  expect(fixture.store.getSnapshot()).toMatchObject({
    status: "locked",
    header: null,
    items: [],
  });
  expect(kvGet(TRAPS_KEY)).toBeNull();
});

it.each(["enroll", "remove", "clear"] as const)(
  "refuses stale %s management across a synthetic round trip without changing records",
  async (operation) => {
    await fixture.enroll("first-retired");
    await probeRetiredCredential("first-retired", "personal");
    const id = retiredCredentialStatus("personal").traps[0]?.id;
    if (!id) throw new Error("The enrolled trap must have an identifier.");
    const before = kvGet(TRAPS_KEY);
    let crossed = false;
    retiredCredentialStorageSeams.refresh = async (key) => {
      if (key === TRAPS_KEY && !crossed) {
        crossed = true;
        markDecoySession(true);
        markDecoySession(false);
      }
    };
    const actions = {
      enroll: () => fixture.enroll("second-retired"),
      remove: () =>
        removeRetiredCredential({
          tomb: "personal",
          currentPassword: PASSWORD,
          id,
        }),
      clear: () =>
        clearRetiredCredentialEvents({
          tomb: "personal",
          currentPassword: PASSWORD,
        }),
    };
    await expect(actions[operation]()).rejects.toThrow(/authenticate again/);
    expect(crossed).toBe(true);
    expect(kvGet(TRAPS_KEY)).toBe(before);
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: "locked",
      header: null,
      items: [],
    });
  },
);
