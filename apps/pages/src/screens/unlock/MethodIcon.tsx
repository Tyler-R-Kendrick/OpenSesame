import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { IconLock, IconPasskey, IconShield } from "../../components/Icons.js";
import { isCeremonyMethod } from "./labels.js";

/** The glyph on an unlock method's tab: a key for a ceremony, a lock for a PIN. */
export function MethodIcon({ id }: { id: UnlockTabId }) {
  if (isCeremonyMethod(id)) return <IconPasskey size={16} />;
  return id === "pin" ? <IconLock size={16} /> : <IconShield size={16} />;
}
