/**
 * View-model logic for `VaultKeyProtectionPanel` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { protectionLifecycleStubs } from "../../lib/vault/protection/protection-view.js";

export type VaultKeyProtectionActions = {
  onAdd?: () => void;
  onTest?: (protectorId: string) => void;
  onPreferred?: (protectorId: string) => void;
  onRemove?: (protectorId: string) => void;
  onRotateCompromised?: () => void;
};

export function resolveActions(
  actions: VaultKeyProtectionActions | undefined,
): Required<VaultKeyProtectionActions> {
  return {
    onAdd: actions?.onAdd ?? (() => protectionLifecycleStubs.add()),
    onTest: actions?.onTest ?? ((id) => protectionLifecycleStubs.test(id)),
    onPreferred:
      actions?.onPreferred ?? ((id) => protectionLifecycleStubs.preferred(id)),
    onRemove:
      actions?.onRemove ?? ((id) => protectionLifecycleStubs.remove(id)),
    onRotateCompromised:
      actions?.onRotateCompromised ??
      (() => protectionLifecycleStubs.rotateCompromised()),
  };
}
