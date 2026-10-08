import type { PageRuntime } from "./client.js";
import { mountSecurityPanel } from "./panel.js";

/** Start without suspending the entry module: lazy storage helpers may import it. */
export function startSecurityPanel(
  root: HTMLElement,
  runtime: PageRuntime,
  changed: (allowed: boolean) => void,
) {
  let mounted: Awaited<ReturnType<typeof mountSecurityPanel>> | undefined;
  changed(false);
  const ready = mountSecurityPanel(root, runtime, changed).then((panel) => {
    mounted = panel;
    return panel;
  });
  return {
    ready,
    permit: () => mounted?.permit(),
    requireProduction: async () => {
      const panel = await ready;
      await panel.requireProduction();
    },
  };
}
