import {
  type Loadout,
  preferredLoadout,
} from "@opensesame/app-core/lib/keymap/gestures.js";
import type { KeymapScope } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { isTouchPointer } from "../../../lib/gestures.js";
import { GesturesPanel } from "./GesturesPanel.js";
import { KeymapPanel } from "./KeymapPanel.js";
import { LoadoutTabs, loadoutPanelId, loadoutTabId } from "./LoadoutTabs.js";
import { MacrosPanel } from "./MacrosPanel.js";
import { useKeymap, useScopedKeymap } from "./useKeymap.js";
import "./keybindings.css";

/** The loadout a panel's address names, if it names one. */
function loadoutOfHash(hash: string): Loadout | null {
  if (hash === "#settings-gestures") return "gestures";
  if (hash === "#settings-keymap") return "keyboard";
  return null;
}

/**
 * Settings › Keybindings: the keymap in two loadouts, Keyboard and Gestures
 * (ADR 0169), then the macros that bind into either. A device opens on its own
 * loadout — a finger first lands on gestures, anything else on keys — and the
 * other is one tab away: keys still work on a phone with a keyboard, and
 * gestures on a laptop with a touch screen. The scope the keymap is read in
 * is shared, so a key bound to a macro in one listing shows, and is edited,
 * beside the macro (ADR 0156 §6).
 */
export function KeybindingsPanels() {
  const { hash } = useLocation();
  const [scope, setScope] = useState<KeymapScope>("everywhere");
  const [loadout, setLoadout] = useState<Loadout>(
    () => loadoutOfHash(hash) ?? preferredLoadout(isTouchPointer()),
  );
  const state = useScopedKeymap(useKeymap(), scope);
  // A rail entry or a link that names a panel opens the loadout it lives in.
  useEffect(() => {
    const named = loadoutOfHash(hash);
    if (named) setLoadout(named);
  }, [hash]);
  return (
    <>
      <LoadoutTabs selected={loadout} onSelect={setLoadout} />
      <div
        role="tabpanel"
        id={loadoutPanelId(loadout)}
        aria-labelledby={loadoutTabId(loadout)}
        className="kb-loadout"
      >
        {loadout === "gestures" ? (
          <GesturesPanel state={state} />
        ) : (
          <KeymapPanel state={state} scope={scope} onScope={setScope} />
        )}
      </div>
      <MacrosPanel state={state} />
    </>
  );
}
