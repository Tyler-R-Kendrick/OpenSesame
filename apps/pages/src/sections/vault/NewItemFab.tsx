import { type Ref, useCallback } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconDotsVertical, IconPlus } from "../../components/Icons.js";
import { openContextMenu } from "../../components/context-menu/menu-model.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ExportEntry } from "./ExportKey.js";
import { addEntries } from "./add-menu.js";
import "./new-item-fab.css";

/** The menu of the other ways to add, as the context menu draws it. */
function openAddMenu(
  event: { clientX: number; clientY: number; preventDefault: () => void },
  anchor: Element | null,
): void {
  const entries = addEntries().map(({ id, label, run }) => ({
    id,
    label,
    run,
  }));
  openContextMenu(event, anchor, "Add actions", [entries]);
}

/**
 * A phone's Add button, pinned to the bottom corner of the pane.
 *
 * It sits in the vault's own box rather than in a row at the top: the pane
 * does not scroll (its rows do), so the button is always where the thumb is,
 * above the pane's status line and clear of the statusline's prompt. The list
 * pads its last row past it so nothing is ever stranded underneath.
 *
 * The `+` is the default and one tap. Beside it, attached, is a vertical
 * ellipsis, and a long press on the `+` is the same ask (the context menu's
 * own road): both open one menu of the alternatives to a new item — Import,
 * Export, whatever a capability adds — so every way to add is one button.
 */
export function NewItemFab({
  to,
  fabRef,
  shown,
}: {
  to: string;
  fabRef?: Ref<HTMLAnchorElement>;
  /** Where the button is drawn: a phone's tree and list, never an item or the trash. */
  shown: boolean;
}) {
  if (!shown) return null;
  return <AddButton to={to} fabRef={fabRef} />;
}

function AddButton({
  to,
  fabRef,
}: {
  to: string;
  fabRef?: Ref<HTMLAnchorElement>;
}) {
  const flows = useContributions("vault-command");
  // On a phone the guide's Import and Export keys are this button's menu.
  const importGuide = useGuideTarget<HTMLButtonElement>("vault.import");
  const exportGuide = useGuideTarget<HTMLButtonElement>("vault.export");
  const moreRef = useCallback(
    (element: HTMLButtonElement | null) => {
      importGuide(element);
      exportGuide(element);
    },
    [importGuide, exportGuide],
  );
  return (
    <>
      <div
        className="fab"
        onContextMenu={(event) => openAddMenu(event, event.currentTarget)}
      >
        <Link
          ref={fabRef}
          className="fab__add"
          aria-label="New item"
          title="New item (n)"
          to={to}
        >
          <IconPlus size={24} />
        </Link>
        <button
          ref={moreRef}
          type="button"
          className="fab__more"
          aria-label="More ways to add"
          title="Import or export"
          aria-haspopup="menu"
          onClick={(event) => {
            // iOS Safari does not focus a tapped button: take focus first, so
            // closing the menu (or the sheet an entry opens) returns here.
            event.currentTarget.focus();
            const box = event.currentTarget.getBoundingClientRect();
            openAddMenu(
              {
                clientX: box.left,
                clientY: box.top,
                preventDefault: () => event.preventDefault(),
              },
              event.currentTarget,
            );
          }}
        >
          <IconDotsVertical size={22} />
        </button>
      </div>
      {/* The flows the menu starts: they draw nothing but their sheets. */}
      {flows.map(({ id, Entry }) => (Entry ? <Entry key={id} /> : null))}
      <ExportEntry />
    </>
  );
}
