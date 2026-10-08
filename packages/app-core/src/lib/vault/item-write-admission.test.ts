import { createItem, manualPassword } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearActivePresentation } from "../duress/compartment/presentation-runtime.js";
import { openRetiredCredentialDecoy } from "../retired-credentials/session.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { legacyPasswordDigestStore } from "./password-history-legacy.js";
import {
  installPasswordDigestStore,
  passwordPreviouslyUsed,
  resetPasswordHistoryForTest,
} from "./password-history.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  installPasswordDigestStore(legacyPasswordDigestStore);
});
afterEach(() => {
  vi.restoreAllMocks();
  installPasswordDigestStore(null);
  resetPasswordHistoryForTest();
  clearActivePresentation();
  fixture.restore();
});
it.each(["ordinary", "synthetic"])(
  "refuses a suspended real credential insertion across %s owner readmission",
  async (transition) => {
    const entry = createItem("account", "Suspended private account");
    entry.methods = [
      manualPassword(
        `${entry.id}:password`,
        "SUSPENDED_PRIVATE_CREDENTIAL",
        entry.createdAt,
      ),
    ];
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = legacyPasswordDigestStore.digestsFor.bind(
      legacyPasswordDigestStore,
    );
    let first = true;
    vi.spyOn(legacyPasswordDigestStore, "digestsFor").mockImplementation(
      async (scope) => {
        const result = await original(scope);
        if (first) {
          first = false;
          entered();
          await held;
        }
        return result;
      },
    );
    const pending = fixture.store.saveItem(entry);
    const result = pending.then(
      () => "accepted",
      () => "refused",
    );
    await started;
    fixture.store.lock();
    if (transition === "synthetic") {
      await openRetiredCredentialDecoy(
        fixture.store,
        {
          id: "selected",
          createdAt: new Date().toISOString(),
          response: "synthetic_decoy",
        },
        "personal",
      );
      expect(
        JSON.stringify(fixture.store.getSnapshot().rawItems),
      ).not.toContain(entry.id);
      fixture.store.lock();
    }
    await fixture.store.unlock(PASSWORD);
    release();
    expect(await result).toBe("refused");
    expect(
      fixture.store.getSnapshot().items.some((item) => item.id === entry.id),
    ).toBe(false);
    expect(
      fixture.store
        .getSnapshot()
        .rawItems?.some((item) => item.id === entry.id),
    ).toBe(false);
    expect(
      await passwordPreviouslyUsed(
        `personal\u0000${entry.id}`,
        "SUSPENDED_PRIVATE_CREDENTIAL",
      ),
    ).toBe(false);
    await fixture.store.saveItem(entry);
    expect(
      fixture.store.getSnapshot().items.some((item) => item.id === entry.id),
    ).toBe(true);
  },
);
