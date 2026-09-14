import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { NotificationsBar } from "./NotificationsBar.js";
import "./statusline.css";

/**
 * One strip for support, plane truth, and notifications — where there is room
 * for it.
 *
 * A phone does not draw this at all: a second full-width bar under the tab bar
 * is a row of the frame spent on things looked at rarely, so on a phone all of
 * it lives behind the nav's own last item instead (`MoreTab`). The strip stays
 * in the document rather than being unmounted, because it holds the seat the
 * support mark portals into — without a seat the mark falls back to a fixed
 * corner overlay, which is the clutter this removed.
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
