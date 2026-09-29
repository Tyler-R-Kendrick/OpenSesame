import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { CommandBar } from "./CommandBar.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { PendingKeys } from "./PendingKeys.js";
import "./statusline.css";

/**
 * One strip for command, support, plane truth, and notifications.
 *
 * CommandBar lives here — typed or spoken commands on every unlocked screen.
 * Unmatched sentences go to Support. The support sheet keeps its own composer.
 * Beside it, the keys half-typed and what may follow them (`PendingKeys`).
 */
export function Statusline() {
  const connectivityRef = useGuideTarget<HTMLDivElement>("shell.connectivity");
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
      <div className="statusline__planes" ref={connectivityRef}>
        <ConnectivityBar />
      </div>
      <div className="statusline__tools">
        <div ref={notificationsRef}>
          <NotificationsBar />
        </div>
      </div>
    </footer>
  );
}
