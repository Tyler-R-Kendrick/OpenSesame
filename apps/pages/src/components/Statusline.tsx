import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import "./statusline.css";

/**
 * One mono strip of plane truth: support, identity and keys, the bell —
 * four equal keys in one left-aligned row (docs/design/controls.md).
 *
 * Nothing is typed here. The command bar under the crumbs is the shell's one
 * field: a command runs, and a sentence it cannot parse goes to Support as a
 * question. A second field in this strip was a disabled input on every
 * screen for anyone without a model, and it cost a phone a whole row.
 *
 * Below 900px the strip is not drawn at all; its contents sit behind the top
 * bar's overflow key (`MoreMenu`). It stays in the document because it holds
 * the seat the support mark portals into.
 */
export function Statusline() {
  const connectivityRef = useGuideTarget<HTMLDivElement>("shell.connectivity");
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  return (
    <footer className="statusline">
      <SupportSlot />
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
