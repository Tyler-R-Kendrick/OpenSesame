import { parseTotp, totpCode } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { activitySeams } from "../activity-log.js";
import * as manifestAuth from "../vault/protection/manifest-auth.js";
import { installVaultSessionHooks } from "../vault/store-session-hooks.js";
import {
  clearRetiredCredentialEvents,
  probeRetiredCredential,
  removeRetiredCredential,
  retiredCredentialStatus,
} from "./index.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";

const originalActivity = activitySeams.activeTomb;
afterEach(() => {
  vi.restoreAllMocks();
  activitySeams.activeTomb = originalActivity;
});

it.each(["enroll", "remove", "clear"] as const)(
  "cancels %s when its required authentication policy changes",
  async (action) => {
    const fixture = await createRetiredCredentialFixture();
    installVaultSessionHooks(() => fixture.store.getSnapshot());
    if (action !== "enroll") {
      await fixture.enroll("generated former fixture password");
      await probeRetiredCredential(
        "generated former fixture password",
        "personal",
      );
    }
    const previous = retiredCredentialStatus("personal");
    const trapId = previous.traps[0]?.id ?? "";
    const uri = await fixture.store.beginTotpEnrollment();
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    let release = () => {};
    let reached = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = manifestAuth.verifyManifestAuth;
    let confirmations = 0;
    vi.spyOn(manifestAuth, "verifyManifestAuth").mockImplementation(
      async (...args) => {
        await original(...args);
        confirmations += 1;
        if (confirmations === 2) {
          reached();
          await held;
        }
      },
    );
    const operations = {
      enroll: () => fixture.enroll("generated former fixture password"),
      remove: () =>
        removeRetiredCredential({
          tomb: "personal",
          currentPassword: PASSWORD,
          id: trapId,
        }),
      clear: () =>
        clearRetiredCredentialEvents({
          tomb: "personal",
          currentPassword: PASSWORD,
        }),
    };
    const pending = operations[action]().then(
      () => null,
      (error: Error) => error,
    );
    try {
      await started;
      await fixture.store.confirmTotpEnrollment(
        await totpCode(parseTotp(secret)),
      );
      expect(fixture.store.getSnapshot().header?.unlocks?.totp).toBeDefined();
      release();
      expect(await pending).toBeInstanceOf(Error);
      expect(retiredCredentialStatus("personal")).toEqual(previous);
    } finally {
      release();
      await pending;
      fixture.restore();
    }
  },
);
