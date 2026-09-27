/**
 * While this browser is being reset — by this tab, or by another that said
 * so — the app is not drawn. Its memory describes storage that is going and
 * its writes stop, so nothing on a lock screen may still be pressed; the tab
 * then leaves for a fresh document (`reset-browser-run.ts`), or reloads once
 * the resetting tab is done (`browser-reset-channel.ts`).
 */

import {
  browserResetting,
  onBrowserResetting,
} from "@opensesame/app-core/lib/storage-halt.js";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { landFocus } from "../../lib/focus.js";
import "./reset-gate.css";

function Resetting() {
  const ref = useRef<HTMLOutputElement | null>(null);
  // Focus leaves the controls that are gone for the one thing on screen.
  useEffect(() => {
    landFocus(ref.current);
  }, []);
  return (
    <main className="reset-gate" aria-busy="true">
      <output
        ref={ref}
        className="reset-gate__mark"
        aria-label="Resetting this browser"
        title="Resetting this browser"
        tabIndex={-1}
      >
        <IconRefresh size={28} />
      </output>
    </main>
  );
}

export function ResetGate({ children }: { children: ReactNode }) {
  const resetting = useSyncExternalStore(onBrowserResetting, browserResetting);
  return resetting ? <Resetting /> : children;
}
