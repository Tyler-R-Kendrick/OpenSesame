import type { ComponentProps, MouseEvent } from "react";
import { Link } from "react-router";
import { useAscend } from "../lib/pane-trail.js";
import type { VaultPane } from "../lib/vault-list-path.js";

const plain = (event: MouseEvent) =>
  event.button === 0 &&
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

/**
 * A key that climbs to the pane above. Where the panes are drilled into one at
 * a time it returns to that pane's entry in the history instead of pushing a
 * new one (`usePaneTrail`); everywhere else, and for a modified click, it is
 * the ordinary link it always was, and `to` stays its address.
 */
export function UpLink({
  pane,
  to,
  onClick,
  ...rest
}: Omit<ComponentProps<typeof Link>, "to"> & { to: string; pane: VaultPane }) {
  const ascend = useAscend();
  return (
    <Link
      {...rest}
      to={to}
      onClick={(event) => {
        onClick?.(event);
        if (!ascend || event.defaultPrevented || !plain(event)) return;
        event.preventDefault();
        ascend(pane, to);
      }}
    />
  );
}
