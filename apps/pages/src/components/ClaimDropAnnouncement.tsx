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

  return (
    <div className="claim-drop-announcement" role="alert" aria-live="assertive">
      <p className="claim-drop-announcement__text">
        <span className="claim-drop-announcement__title">{banner.title}</span>
        {banner.body}
      </p>
      <button
        type="button"
        className="icon-btn claim-drop-announcement__dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissClaimDropBanner()}
      >
        <IconX size={18} />
      </button>
    </div>
  );
}
