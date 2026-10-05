import type { Ref } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconPlus } from "../../components/Icons.js";
import { ExportKey } from "./ExportKey.js";

/**
 * The keys that add to a vault or take it out: New item, whatever a capability
 * adds beside it (Import, from the formats it reads), and Export.
 *
 * One cluster, two places. The list pane carries it in its command row; a
 * phone's first pane is the section tree, and the same row sits above it so
 * the way to add, import or back up a vault is on the screen a phone opens on
 * rather than a pane away.
 */
export function VaultActions({
  createPath,
  createRef,
}: {
  createPath: string;
  /** Where the list pane records its New key for focus and the guide. */
  createRef?: Ref<HTMLAnchorElement>;
}) {
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
    </>
  );
}

/**
 * Whatever a capability adds beside New item (Import), then Export. Kept apart
 * from New so the phone's Add sheet can mount the same commands without a
 * second key for the one thing it draws itself.
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
