import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { CommandBar } from "./CommandBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { PendingKeys } from "./PendingKeys.js";
import "./statusline.css";

/**
 * One strip for command, support, and notifications.
 *
 * CommandBar lives here — typed commands on every unlocked screen.
 * A model capability, when it is on, also reads a question. The support
 * sheet keeps its own composer.
 * Beside it, the keys half-typed and what may follow them (`PendingKeys`).
 */
export function Statusline() {
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  return (
    <footer className="statusline">
      <SupportSlot />
      <div className="statusline__command">
        <CommandBar />
      </div>
      <PendingKeys />
      <div className="statusline__tools">
        <div ref={notificationsRef}>
          <NotificationsBar />
        </div>
      </div>
    </footer>
  );
}
