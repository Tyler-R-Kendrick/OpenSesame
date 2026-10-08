import { reportGuideActivation } from "@opensesame/app-core/tutorial/registry/targets.js";
import { useCallback } from "react";
import { Link } from "react-router";
import { useContributions } from "../../bindings/contributions.js";
import { IconPlus } from "../../components/Icons.js";
import {
  type MenuOpening,
  openContextMenu,
} from "../../components/context-menu/menu-model.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { AddSlide } from "./AddSlide.js";
import { ClaimOpenEntry } from "./ClaimOpen.js";
import { ExportEntry } from "./ExportKey.js";
import { type AddEntry, addEntries } from "./add-menu.js";
import { useAddSlide } from "./add-slide.js";
import "./new-item-fab.css";

/**
 * Run an entry the person chose, by the slide or by the menu, and tell the
 * guide: on a phone the guide's Import and Export keys are this button's, and
 * neither road clicks them.
 */
function chooseEntry(entry: AddEntry): void {
  entry.run();
  if (entry.id === "import") reportGuideActivation("vault.import");
  if (entry.id === "export") reportGuideActivation("vault.export");
}

/**
 * The other ways to add as a menu: the road for a keyboard, a screen reader
 * or a mouse, none of which can hold and slide. A held finger never opens it.
 */
function openAddMenu(event: MenuOpening, anchor: Element | null): void {
  const entries = addEntries().map((entry) => ({
    id: entry.id,
    label: entry.label,
    run: () => chooseEntry(entry),
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
 * The `+` is one tap. Holding it draws a drag area around it, with the other
 * ways to add named on it: slide up to Import, down to Export, and let go
 * there (`AddSlide`). Letting go anywhere else chooses nothing. It is a sharp
 * square, like every control (DESIGN.md § Shapes).
 */
export function NewItemFab({
  to,
  fabRef,
  shown,
}: {
  to: string;
  /** The shell's record of where New item is, for focus and the guide. */
  fabRef?: (element: HTMLAnchorElement | null) => void;
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
  fabRef?: (element: HTMLAnchorElement | null) => void;
}) {
  const flows = useContributions("vault-command");
  // The button is not clicked to reach Import or Export, so the guide is told
  // when one is chosen (`chooseEntry`) rather than when the `+` is tapped.
  const importGuide = useGuideTarget<HTMLAnchorElement>("vault.import", {
    activation: "manual",
  });
  const exportGuide = useGuideTarget<HTMLAnchorElement>("vault.export", {
    activation: "manual",
  });
  const slide = useAddSlide(chooseEntry);
  const plusRef = useCallback(
    (element: HTMLAnchorElement | null) => {
      importGuide(element);
      exportGuide(element);
      fabRef?.(element);
    },
    [importGuide, exportGuide, fabRef],
  );
  return (
    <>
      <div
        className="fab"
        data-own-hold=""
        onContextMenu={(event) => {
          // Never the link's own menu; and a held finger's is the slide's.
          event.preventDefault();
          if (slide.holding()) return;
          openAddMenu(event, event.currentTarget);
        }}
      >
        <Link
          ref={plusRef}
          className="fab__add"
          aria-label="New item"
          title="New item (n)"
          to={to}
          draggable={false}
          {...slide.bind}
        >
          <IconPlus size={24} />
        </Link>
      </div>
      {slide.state ? <AddSlide slide={slide.state} /> : null}
      {/* The flows the slide starts: they draw nothing but their sheets. */}
      {flows.map(({ id, Entry }) => (Entry ? <Entry key={id} /> : null))}
      <ExportEntry />
      <ClaimOpenEntry />
    </>
  );
}
