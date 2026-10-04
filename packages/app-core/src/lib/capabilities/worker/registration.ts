/**
 * What the controller reads of the registration and asks of the container:
 * which variant a script is, the newest worker the scope holds, whether a
 * variant may run yet, and the register and getRegistration calls themselves.
 */

import { sameScript, scriptUrlFor, workerControllerSeams } from "./seams.js";
import { diagnose, state } from "./state.js";
import {
  CORE_ONLY_VARIANT,
  type CompositionSnapshotForWorker,
  VARIANT_CAPABILITY,
} from "./types.js";

/** Which variant a registered script is, by the distribution's table. */
export function variantOfScript(scriptUrl: string | null): string | null {
  if (scriptUrl === null) return null;
  const variant = state.distribution?.workerVariants.find((v) =>
    sameScript(scriptUrlFor(v.scriptPath), scriptUrl),
  );
  return variant?.id ?? null;
}

/**
 * The script this scope is running or about to run: the newest worker first,
 * so a replacement still installing counts as the answer and is not asked for
 * a second time.
 */
export function newestScript(
  registration: ServiceWorkerRegistration | undefined,
): string | null {
  if (!registration) return null;
  return (
    registration.installing?.scriptURL ??
    registration.waiting?.scriptURL ??
    registration.active?.scriptURL ??
    null
  );
}

/**
 * Whether the installation may run this variant yet. Core-only always; any
 * other variant only once a persisted selection and receipt exist, and, for a
 * variant that serves one capability, only when that capability is approved
 * and named in the receipt (PWA-03).
 */
export function variantEligible(
  id: string,
  snapshot: CompositionSnapshotForWorker,
): boolean {
  if (id === CORE_ONLY_VARIANT) return true;
  const { plan, selection, receipt } = snapshot;
  if (!plan || !selection || !receipt) return false;
  const capability = VARIANT_CAPABILITY.get(id);
  if (!capability) return true;
  return (
    plan.approvedCapabilities.includes(capability) &&
    capability in receipt.exposure
  );
}

export async function register(
  container: ServiceWorkerContainer,
  scriptUrl: string,
): Promise<ServiceWorkerRegistration | null> {
  state.registeredThisPage = true;
  try {
    return await container.register(scriptUrl, {
      type: "classic",
      updateViaCache: "none",
      scope: workerControllerSeams.baseUrl(),
    });
  } catch {
    diagnose("WORKER_REGISTRATION_FAILED");
    return null;
  }
}

export async function currentRegistration(
  container: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await container.getRegistration(workerControllerSeams.baseUrl());
  } catch {
    return undefined;
  }
}
