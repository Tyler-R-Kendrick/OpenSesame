import type { Ref } from "react";
import { Link } from "react-router";
import { IconPlus } from "../../components/Icons.js";
import "./new-item-fab.css";

/**
 * A phone's one primary action, pinned to the bottom corner of the pane.
 *
 * It sits in the vault's own box rather than in a row at the top: the pane
 * does not scroll (its rows do), so the button is always where the thumb is,
 * above the pane's status line and clear of the statusline's prompt. The list
 * pads its last row past it so nothing is ever stranded underneath.
 */
export function NewItemFab({
  to,
  fabRef,
}: {
  to: string;
  fabRef?: Ref<HTMLAnchorElement>;
}) {
  return (
    <Link
      ref={fabRef}
      className="fab"
      aria-label="New item"
      title="New item (n)"
      to={to}
    >
      <IconPlus size={24} />
    </Link>
  );
}
