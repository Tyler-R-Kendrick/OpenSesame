import type { Ref } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconPlus } from "../../components/Icons.js";
import { ExportKey } from "./ExportKey.js";

/**
 * The keys that add to a vault or take it out: New item, whatever a capability
 * adds beside it (Import, from the formats it reads), and Export.
 *
 * On a phone New leaves the cluster for `NewItemFab`, the one primary action
 * pinned to the corner where a thumb already rests; the rest stay in the row.
 *
 * One cluster, two places. The list pane carries it in its command row; a
 * phone's first pane is the section tree, and the same row sits above it so
 * the way to add, import or back up a vault is on the screen a phone opens on
 * rather than a pane away.
 */
export function VaultActions({
  createPath,
  createRef,
  create = true,
}: {
  createPath: string;
  /** Where the list pane records its New key for focus and the guide. */
  createRef?: Ref<HTMLAnchorElement>;
  /** False where New is drawn elsewhere: a phone's corner button. */
  create?: boolean;
}) {
  const commands = useContributions("vault-command");
  return (
    <>
      {create ? (
        <Link
          ref={createRef}
          className="icon-btn icon-btn--sm"
          aria-label="New item"
          title="New item (n)"
          to={createPath}
        >
          <IconPlus size={15} />
        </Link>
      ) : null}
      {commands.map(({ id, Command }) => (
        <Command key={id} />
      ))}
      <ExportKey />
    </>
  );
}
