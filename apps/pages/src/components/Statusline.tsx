import { useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { SupportSlot } from "../tutorial/ui/SupportLauncher.js";
import { ConnectivityBar } from "./ConnectivityBar.js";
import { IconLock } from "./Icons.js";
import { NotificationsBar } from "./NotificationsBar.js";
import "./statusline.css";

/** One strip for support, plane truth, notifications, and lock at every width. */
export function Statusline() {
  const store = useVaultStore();
  const connectivityRef = useGuideTarget<HTMLDivElement>("shell.connectivity");
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  const lockRef = useGuideTarget<HTMLButtonElement>("shell.lock");
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
        <button
          ref={lockRef}
          type="button"
          className="icon-btn"
          onClick={store.lock}
          aria-label="Lock vault"
          title="Lock vault"
        >
          <IconLock size={17} />
        </button>
      </div>
    </footer>
  );
}
