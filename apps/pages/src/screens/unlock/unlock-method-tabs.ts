import {
  type UnlockTabId,
  listProtectorUnlockTabs,
} from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import {
  listAvailableUnlockMethods,
  preferredUnlockMethod,
} from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { tabsThatCarryArmedPrf } from "@opensesame/app-core/screens/unlock/unlock-prf-trigger.js";
import type { VaultHeader } from "@opensesame/vault-core";

type Header = VaultHeader | null | undefined;

/**
 * The tabs the unlock screen draws. A returning vault offers exactly the
 * challenges it enrolled — the header on disk is plaintext and already says
 * which, so hiding the rest protected nothing and cost the person their own
 * configuration. Beside them, the manifest's protectors that open the vault
 * from material nothing sealed inside it holds (ADR 0152). A road that cannot
 * carry an armed `prf_and_code` duress trigger is not drawn.
 */
export function unlockMethodTabs(input: {
  firstRun: boolean;
  header: Header;
  passkeyOk: boolean;
}): UnlockTabId[] {
  if (input.firstRun) {
    const available: UnlockTabId[] = [];
    if (input.passkeyOk) available.push("passkey");
    available.push("pin", "password");
    return available;
  }
  const own: UnlockTabId[] = listAvailableUnlockMethods(input.header);
  return tabsThatCarryArmedPrf(
    [
      ...own,
      ...listProtectorUnlockTabs(input.header).filter(
        (tab) => !own.includes(tab),
      ),
    ],
    input.header,
  );
}

/** The tab a screen opens on: the preferred one when it is drawn at all. */
export function fallbackUnlockMethod(input: {
  firstRun: boolean;
  header: Header;
  passkeyOk: boolean;
  methods: readonly UnlockTabId[];
}): UnlockTabId {
  if (input.firstRun) return input.passkeyOk ? "passkey" : "password";
  const preferred = preferredUnlockMethod(input.header);
  if (preferred && input.methods.includes(preferred)) return preferred;
  return input.methods[0] ?? preferred ?? "password";
}
