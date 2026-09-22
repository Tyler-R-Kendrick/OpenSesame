/**
 * The support feature as one wrapper around the shell body: the controller
 * provider, the statusline seat both it and `components/Statusline.tsx`
 * share, and the question mark that opens the panel.
 *
 * `app-root.tsx` used to nest these three around the shell itself
 * (`SupportProvider` / `SupportSlotProvider` / `SupportLauncher`). They are
 * one component here so the core shell knows only "a capability wraps the
 * body", and so nothing of the support tree — the panel, Driver.js, the
 * guide runtime, the agents — is reachable from a build that excludes this
 * capability.
 *
 * Nothing in the tree acts on the page. `SupportLauncher` draws a button;
 * the panel behind it is `lazy`, so a vault that never asks for help never
 * fetches the renderer.
 */

import type { ReactElement, ReactNode } from "react";
import { SupportProvider } from "../../tutorial/session.js";
import {
  SupportLauncher,
  SupportSlotProvider,
} from "../../tutorial/ui/SupportLauncher.js";

export function SupportShell({
  children,
}: { children?: ReactNode }): ReactElement {
  return (
    <SupportProvider>
      <SupportSlotProvider>
        {children}
        <SupportLauncher />
      </SupportSlotProvider>
    </SupportProvider>
  );
}
