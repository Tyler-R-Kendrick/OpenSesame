import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { assertNewPassword, withNewPassword } from "./unlock-secret-guard.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
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
