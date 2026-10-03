import type { KeymapScope } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useState } from "react";
import { KeymapPanel } from "./KeymapPanel.js";
import { MacrosPanel } from "./MacrosPanel.js";
import { useKeymap, useScopedKeymap } from "./useKeymap.js";
import "./keybindings.css";

/**
 * Settings › Keybindings: the keymap, then the macros that bind into it. The
 * scope the keymap is read in is shared, so a key bound to a macro in one
 * listing shows, and is edited, beside the macro (ADR 0156 §6).
 */
export function KeybindingsPanels() {
  const [scope, setScope] = useState<KeymapScope>("everywhere");
  const state = useScopedKeymap(useKeymap(), scope);
  return (
    <>
      <KeymapPanel state={state} scope={scope} onScope={setScope} />
      <MacrosPanel state={state} />
    </>
  );
}
