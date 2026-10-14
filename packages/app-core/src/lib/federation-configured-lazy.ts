/** Ordinary startup reads only public trust; native adapters load for a saved native sign-in. */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type {
  RestorationResult,
  RestorationTrust,
} from "./federation-restoration.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import { signInMethods } from "./settings.js";

export type NativeRestorationRuntime = Pick<
  typeof import("./federation-configured-restoration.js"),
  "restoreConfiguredIdentitySession" | "restoreConfiguredIdentityAtBoot"
>;
export const configuredIdentityLazySeams = {
  load: (): Promise<NativeRestorationRuntime> =>
    import("./federation-configured-restoration.js"),
};

function configuredNativeSession(upstreamId: string): boolean {
  if (!upstreamId.startsWith("identity:")) return false;
  const id = upstreamId.slice("identity:".length);
  const provider = signInMethods().providers.find(
    (entry) => entry.connectionId === id,
  );
  return (
    provider?.protocol === "better-auth" || provider?.protocol === "supabase"
  );
}

export async function restoreConfiguredIdentityIfNative(
  stored: JsonObject,
  trust: RestorationTrust,
): Promise<RestorationResult | null> {
  if (
    !isString(stored.upstreamId) ||
    !configuredNativeSession(stored.upstreamId)
  )
    return null;
  const { restoreConfiguredIdentitySession } =
    await configuredIdentityLazySeams.load();
  return restoreConfiguredIdentitySession(
    stored.upstreamId,
    String(stored.idToken),
    trust,
  );
}

/** Does not block boot, load native code, or contact an IdP in an unconfigured application. */
export function restoreConfiguredIdentityAtBootIfPresent(): void {
  const raw = readFederationSessionJson();
  if (!raw) return;
  let stored: BoundaryValue;
  try {
    stored = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !isJsonObject(stored) ||
    !isString(stored.upstreamId) ||
    !configuredNativeSession(stored.upstreamId)
  )
    return;
  void configuredIdentityLazySeams
    .load()
    .then(({ restoreConfiguredIdentityAtBoot }) =>
      restoreConfiguredIdentityAtBoot(),
    )
    .catch(() => {});
}
