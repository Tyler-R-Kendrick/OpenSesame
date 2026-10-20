import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { CommandBar } from "./CommandBar.js";
import { PendingKeys } from "./PendingKeys.js";
import "./statusline.css";

/**
 * One strip for commands, support, and pending keys.
 *
 * CommandBar lives here — typed commands on every unlocked screen.
 * A model capability, when it is on, also reads a question. The support
 * sheet keeps its own composer.
 * Beside it, the keys half-typed and what may follow them (`PendingKeys`).
 * Notifications live in the shared application header.
 */
export function Statusline() {
  return (
    <footer className="statusline">
      <SupportSlot />
      <div className="statusline__command">
        <CommandBar />
      </div>
      <PendingKeys />
    </footer>
  );
}
