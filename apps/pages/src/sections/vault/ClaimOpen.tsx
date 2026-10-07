import { useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { IconShare } from "../../components/Icons.js";
import { useAddEntry } from "./add-menu.js";

/**
 * Open `/claim` from the vault. A claim or a drop is pasted there. The link
 * is client-side, so an unlocked vault stays unlocked. On a phone the same
 * destination is an Add-menu entry, not a slide.
 */
export function ClaimOpenLink() {
  return (
    <Link
      className="icon-btn icon-btn--sm"
      aria-label="Open a claim"
      title="Open a claim"
      to="/claim"
    >
      <IconShare size={15} />
    </Link>
  );
}

/** The phone Add menu's road to `/claim`. Draws nothing of its own. */
export function ClaimOpenEntry() {
  const navigate = useNavigate();
  const open = useCallback(() => {
    navigate("/claim");
  }, [navigate]);
  useAddEntry({
    id: "claim",
    label: "Open a claim",
    order: 40,
    run: open,
  });
  return null;
}
