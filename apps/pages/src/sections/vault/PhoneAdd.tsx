import type { MouseEvent, ReactNode } from "react";
import { useRef } from "react";
import { useNavigate } from "react-router";
import {
  IconDownload,
  IconPlus,
  IconSearch,
  IconUpload,
} from "../../components/Icons.js";
import {
  type MenuGroup,
  openContextMenu,
} from "../../components/context-menu/menu-model.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { VaultCommands } from "./VaultActions.js";

/**
 * What the section tree asks of a thumb: find something, or add something.
 *
 * Search is the field the tree opens on, the full width of the screen, because
 * finding is what a phone opens a vault for. Adding is one filled key in the
 * bottom corner a right thumb already rests on. Neither is the desktop's row of
 * small keys: import and export are not as common as New, so they are rows of
 * the action sheet the key opens instead of keys of their own.
 */
export function PhoneFind({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="vadd__find"
      aria-label="Search the vault"
      onClick={onOpen}
    >
      <IconSearch size={18} />
      <span className="vadd__prompt" aria-hidden="true">
        Search the vault
      </span>
    </button>
  );
}

/** A glyph for the commands the vault is known to carry; others have none. */
const ICONS: Record<string, ReactNode> = {
  "Import items": <IconDownload size={16} />,
  "Export items": <IconUpload size={16} />,
};

export function PhoneAdd({ createPath }: { createPath: string }) {
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  // The Add key is the one door to all three on a phone: the keys the tours
  // point at on a wide screen are rows of its sheet here, so the registry
  // points at it while those keys are not drawn.
  const guideCreate = useGuideTarget<HTMLButtonElement>("vault.create");
  const guideImport = useGuideTarget<HTMLButtonElement>("vault.import");
  const guideExport = useGuideTarget<HTMLButtonElement>("vault.export");

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    // Import and Export are the commands the desktop draws as keys. They stay
    // mounted, hidden, because each owns the sheet or file picker it opens;
    // a row of the sheet presses its key.
    const keys = [
      ...(host.current?.querySelectorAll<HTMLElement>(
        ":scope > button, :scope > a",
      ) ?? []),
    ];
    // A command with no name has no row: an empty entry is worse than none.
    const more: MenuGroup = keys.flatMap((key) => {
      const label = key.getAttribute("aria-label") ?? key.title;
      if (!label) return [];
      return [{ id: label, label, icon: ICONS[label], run: () => key.click() }];
    });
    openContextMenu(event, event.currentTarget, "Add to the vault", [
      [
        {
          id: "new-item",
          label: "New item",
          icon: <IconPlus size={16} />,
          run: () => navigate(createPath),
        },
      ],
      more,
    ]);
  };

  return (
    <>
      <button
        ref={(element) => {
          guideCreate(element);
          guideImport(element);
          guideExport(element);
        }}
        type="button"
        className="vadd__key"
        aria-label="Add"
        aria-haspopup="menu"
        onClick={open}
      >
        <IconPlus size={26} />
      </button>
      <div ref={host} className="vadd__host">
        <VaultCommands />
      </div>
    </>
  );
}
