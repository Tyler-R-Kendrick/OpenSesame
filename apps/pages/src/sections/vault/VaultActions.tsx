import type { Ref } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconPlus } from "../../components/Icons.js";
import { ExportKey } from "./ExportKey.js";

/**
 * The keys that add to a vault or take it out: New item, whatever a capability
 * adds beside it (Import, from the formats it reads), and Export.
 *
 * A desktop's list carries the cluster in its command row. A phone does not
 * draw it: New is `NewItemFab`, the one primary action pinned to the corner
 * where a thumb rests, and Import and Export are labelled rows among
 * `VaultTools` on the screen a phone opens on.
 */
export function VaultActions({
  createPath,
  createRef,
  hidden = false,
}: {
  createPath: string;
  /** Where the list pane records its New key for focus and the guide. */
  createRef?: Ref<HTMLAnchorElement>;
  /** A phone draws none of this cluster: see `NewItemFab` and `VaultTools`. */
  hidden?: boolean;
}) {
  const commands = useContributions("vault-command");
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
      {commands.map(({ id, Command }) => (
        <Command key={id} />
      ))}
      <ExportKey />
    </>
  );
}
