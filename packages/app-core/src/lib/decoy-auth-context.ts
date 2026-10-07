import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
/** The pending proof belongs to this tab, never to a device incident fence. */
import { host } from "../host.js";
import { maybeSessionStore } from "../ports.js";

const CONTEXT_KEY = "opensesame.decoy-fresh-owner-auth.v1";
export type PendingOwnerContext = {
  tomb: string | null;
  vaultIdentity: string | null;
};
let restoredHost: ReturnType<typeof host> | undefined;

function nullableIdentifier(value: BoundaryValue): value is string | null {
  return value === null || (isString(value) && value.length <= 256);
}
function parsePendingOwnerContext(raw: string): PendingOwnerContext {
  const refused = { tomb: null, vaultIdentity: null };
  if (raw.length > 512) return refused;
  const value: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(value) || value.v !== 1 || Object.keys(value).length !== 3)
    return refused;
  if (
    !nullableIdentifier(value.tomb) ||
    !nullableIdentifier(value.vaultIdentity)
  )
    return refused;
  return { tomb: value.tomb, vaultIdentity: value.vaultIdentity };
}

export function restorePendingOwnerContext(): PendingOwnerContext | undefined {
  const installed = globalThis.__opensesameAppCoreHost;
  if (!installed || restoredHost === installed) return undefined;
  try {
    const store = maybeSessionStore();
    if (!store) {
      restoredHost = installed;
      return undefined;
    }
    const raw = store.getItem(CONTEXT_KEY);
    if (raw === null) {
      restoredHost = installed;
      return undefined;
    }
    const context = parsePendingOwnerContext(raw);
    restoredHost = installed;
    return context;
  } catch {
    // A sealed context whose device key is still loading is retried; meanwhile
    // no production transport or cached authority is admitted.
    return { tomb: null, vaultIdentity: null };
  }
}

export function persistPendingOwnerContext(
  tomb: string | null,
  vaultIdentity: string | null,
): void {
  const store = maybeSessionStore();
  if (!store) {
    if (host().page)
      throw new Error(
        "Synthetic sessions require tab storage before proceeding.",
      );
    return;
  }
  store.setItem(CONTEXT_KEY, JSON.stringify({ v: 1, tomb, vaultIdentity }));
}

export function removePendingOwnerContext(): void {
  maybeSessionStore()?.removeItem(CONTEXT_KEY);
}
