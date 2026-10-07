import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
/** Encrypted-search routing activates only after a complete durable handoff.
 * Disposal waits for owned marker release before returning to legacy routing. */
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { installEncryptedStores } from "@opensesame/app-core/lib/encrypted-db/install.js";

export const CAPABILITY = "storage.encrypted-search";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    if (ctx.lease.signal.aborted)
      return { capability: CAPABILITY, dispose: () => {} };
    const stores = installEncryptedStores();
    let cleanup: Promise<void> | undefined;
    const dispose = () => {
      ctx.lease.signal.removeEventListener("abort", onAbort);
      cleanup ??= stores.uninstall();
      return cleanup;
    };
    const onAbort = () => {
      // The loader also awaits this same cleanup promise; an abort event has
      // no async caller and must not produce an unhandled rejection.
      void dispose().catch(() => {});
    };
    ctx.lease.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const report = await stores.migrated;
      if (!report.complete && (await atRestReady()).durable)
        throw new Error(
          "Encrypted storage transfer incomplete; retry activation",
        );
      if (ctx.lease.signal.aborted) await dispose();
      return { capability: CAPABILITY, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  },
};
