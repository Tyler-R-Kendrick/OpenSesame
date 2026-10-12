import type { Ref } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconPlus } from "../../components/Icons.js";
import { ClaimOpenLink } from "./ClaimOpen.js";
import { ExportKey } from "./ExportKey.js";

/**
 * The keys that add to a vault or take it out: New item, whatever a capability
 * adds beside it (Import, from the formats it reads), and Export.
 *
 * A desktop's list carries the cluster in its command row. A phone does not
 * draw it: Add is `NewItemFab` — the `+` for a new item, with Import and
 * Export chosen by holding it and sliding up or down.
 */
export function VaultActions({
  createPath,
  createRef,
  hidden = false,
}: {
  createPath: string;
  /** Where the list pane records its New key for focus and the guide. */
  createRef?: Ref<HTMLAnchorElement>;
  /** A phone draws none of this cluster: see `NewItemFab`. */
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <>
      <Link
        ref={createRef}
        className="icon-btn icon-btn--sm"
        aria-label="New item"
        title="New item (n)"
        to={createPath}
      >
        <IconPlus size={15} />
      </Link>
      <VaultCommands />
      <ClaimOpenLink />
    </>
  );
}

/**
 * Whatever a capability adds beside New item (Import), then Export: the icon
 * keys of a desktop's command row.
 */
export function VaultCommands() {
  const commands = useContributions("vault-command");
  return (
    <>
      {commands.map(({ id, Command }) => (
        <Command key={id} />
      ))}
      <ExportKey />
    </>
  );
}
