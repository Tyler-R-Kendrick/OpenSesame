/**
 * Handle bookkeeping every module runtime shares.
 *
 * `createActivation` wraps `ctx.register` so a runtime can register freely
 * and hand back one `dispose` that revokes every handle in reverse order,
 * runs the module's own cleanups, and is idempotent. A lease that aborts
 * disposes the activation the same way, so a module never has to listen for
 * the abort itself.
 */

import type {
  ApprovedCapabilityContext,
  ContributionEntry,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type {
  ContributionKind,
  RegistrationHandle,
  RuntimeHandle,
} from "@opensesame/capability-composition";

export type Activation = Readonly<{
  /** Register through the context and remember the handle. */
  register: <K extends ContributionKind>(
    kind: K,
    entry: ContributionEntry<K>,
  ) => RegistrationHandle;
  /** Run `fn` on dispose (listeners, timers, in-memory state). */
  onDispose: (fn: () => void) => void;
  /** True once `dispose` ran or the lease aborted. */
  disposed: () => boolean;
  /** Idempotent: revoke every handle, then run cleanups, newest first. */
  dispose: () => void;
  /** The runtime handle to return from `activate`. */
  handle: () => RuntimeHandle;
}>;

export function createActivation(
  ctx: ApprovedCapabilityContext,
  capability: string,
): Activation {
  const handles: RegistrationHandle[] = [];
  const cleanups: Array<() => void> = [];
  let done = false;

  const dispose = () => {
    if (done) return;
    done = true;
    ctx.lease.signal.removeEventListener("abort", dispose);
    while (handles.length > 0) {
      const handle = handles.pop();
      try {
        handle?.revoke();
      } catch {
        // A registrar that already dropped this generation has nothing left
        // to revoke; disposal keeps going.
      }
    }
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try {
        cleanup?.();
      } catch {
        // Same: one failed cleanup must not keep the rest alive.
      }
    }
  };

  if (ctx.lease.signal.aborted) done = true;
  else ctx.lease.signal.addEventListener("abort", dispose, { once: true });

  return {
    register: (kind, entry) => {
      if (done) {
        throw new Error(`activation disposed: cannot register ${kind}`);
      }
      const handle = ctx.register(kind, entry);
      handles.push(handle);
      return handle;
    },
    onDispose: (fn) => {
      if (done) fn();
      else cleanups.push(fn);
    },
    disposed: () => done,
    dispose,
    handle: () => ({ capability, dispose }),
  };
}
