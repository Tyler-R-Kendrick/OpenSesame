import { useContext, useSyncExternalStore } from "react";
import type { SupportAccess } from "./session.js";
import { SupportContext } from "./support-context.js";

const noSubscribe = (): (() => void) => () => {};
const noView = (): null => null;

/**
 * Support if the tree has it, else null. For chrome that hands a question on
 * when it can (the command bar) but must not fail where support is not
 * mounted — a test shell, a screen outside the provider. Both hooks are
 * called unconditionally, so the rules of hooks hold either way.
 */
export function useSupportIfMounted(): SupportAccess | null {
  const controller = useContext(SupportContext);
  const view = useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.view : noView,
  );
  return controller && view ? { view, support: controller } : null;
}
