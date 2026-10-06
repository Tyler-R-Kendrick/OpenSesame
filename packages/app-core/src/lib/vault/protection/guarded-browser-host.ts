import { assertSessionGeneration } from "./adapter.js";
import type { ProtectionBrowserHost } from "./browser-service.js";

export type GuardedProtectionHost = ProtectionBrowserHost & {
  assertCurrent(): void;
};

/** One request retains its original session, including all helper callbacks. */
export function guardProtectionHost(
  host: ProtectionBrowserHost,
  allowKeyAdmission = false,
): GuardedProtectionHost {
  const generation = host.session.generation;
  const context = host.pinContext?.(allowKeyAdmission);
  const check = () => {
    assertSessionGeneration(generation, host.session.generation);
    context?.();
  };
  const read =
    <T>(value: () => T): (() => T) =>
    () => {
      check();
      return value();
    };
  return {
    session: host.session,
    assertCurrent: check,
    isGuestOrEphemeral: read(() => host.isGuestOrEphemeral()),
    getHeader: read(() => host.getHeader()),
    requireRawRoot: read(() => host.requireRawRoot()),
    isUnlocked: read(() => host.isUnlocked()),
    persistHeader: async (next) => {
      check();
      await host.persistHeader(next);
      check();
    },
    replaceRawVaultKey: async (next, header) => {
      try {
        check();
        await host.replaceRawVaultKey(next, header);
        check();
      } catch (error) {
        next.fill(0);
        throw error;
      }
    },
  };
}
