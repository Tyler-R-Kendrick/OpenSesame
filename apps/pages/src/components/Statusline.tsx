import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportAskSlot, SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import "./statusline.css";

/**
 * One strip for asking, support, plane truth, and notifications.
 *
 * The ask field lives here — outer chrome, not the support sheet — so it is
 * on every unlocked screen. Below 900px the plane glyphs and bell stay behind
 * the top bar's overflow key; the strip itself still draws, because that is
 * where a question is typed.
 */
export function Statusline() {
  const connectivityRef = useGuideTarget<HTMLDivElement>("shell.connectivity");
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  return (
    <footer className="statusline">
      <SupportSlot />
      <SupportAskSlot />
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
