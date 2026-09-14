import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { StatuslineMore } from "./StatuslineMore.js";
import "./statusline.css";

/**
 * One strip for support, plane truth, and notifications.
 *
 * Two arrangements, because a phone is not a narrow desktop. With room, the
 * five connector glyphs are the strip: a glance costs nothing and the pips are
 * the point. On a phone they roll up into the overflow key, which carries the
 * same aggregate pip and says in words what five mute glyphs did not. Both are
 * always in the document — one is hidden by a media query, the way the vault
 * filters are already chips on a phone and rail rows on a desktop.
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
        <StatuslineMore />
      </div>
    </footer>
  );
}
