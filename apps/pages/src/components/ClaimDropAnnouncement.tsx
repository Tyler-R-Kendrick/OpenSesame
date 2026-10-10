import {
  claimDropBannerSnapshot,
  dismissClaimDropBanner,
  subscribeClaimDropBanner,
} from "@opensesame/app-core/lib/claims/claim-drop-banner.js";
import { useEffect, useSyncExternalStore } from "react";
import { IconX } from "./Icons.js";

/**
 * Optional top overlay for the latest claim or drop failure. Tray history
 * stays in the bell; this bar holds one dismissable message at a time.
 */
export function ClaimDropAnnouncement() {
  const banner = useSyncExternalStore(
    subscribeClaimDropBanner,
    claimDropBannerSnapshot,
    () => null,
  );

  useEffect(() => {
    if (!banner) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismissClaimDropBanner();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [banner]);

  if (!banner) return null;

  const barStyle = {
    position: "fixed" as const,
    inset: "0 0 auto",
    zIndex: 40,
    display: "flex",
    gap: "0.75rem",
    margin: 0,
    padding: "max(0.75rem, env(safe-area-inset-top)) 1rem 0.75rem",
    border: 0,
    borderBottom: "1px solid var(--line)",
    background: "var(--surface)",
  };
  const textStyle = { flex: 1, minWidth: 0, margin: 0 };

  return (
    <div style={barStyle} role="alert" aria-live="assertive">
      <p style={textStyle}>
        <span>{banner.title}</span>
        {" — "}
        {banner.body}
      </p>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissClaimDropBanner()}
      >
        <IconX size={18} />
      </button>
    </div>
  );
}
