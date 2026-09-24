/**
 * Whether the person in front of Settings › Capabilities operates this
 * device's installation: a personal-local policy, the personal tomb, not a
 * guest. The instance policy and Allow guests are theirs alone; a member of
 * a managed instance, a project tomb or a guest never sees either control —
 * the control renders nothing, not a disabled form (SURFACE-06).
 */

import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { useComposition } from "../../bindings/capabilities.js";
import { useVault } from "../../lib/vault/hooks.js";

export function useDeviceOperator(): boolean {
  const { provenance } = useComposition();
  const { tomb, guest } = useVault();
  return provenance === "personal-local" && tomb === PERSONAL_TOMB && !guest;
}
