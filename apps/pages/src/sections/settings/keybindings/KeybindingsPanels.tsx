import { KeymapPanel } from "./KeymapPanel.js";
import { MacrosPanel } from "./MacrosPanel.js";
import { useKeymap } from "./useKeymap.js";
import "./keybindings.css";

/** Settings › Keybindings: the keymap, then the macros that bind into it. */
export function KeybindingsPanels() {
  const state = useKeymap();
  return (
    <>
      <KeymapPanel state={state} />
      <MacrosPanel state={state} />
    </>
  );
}
