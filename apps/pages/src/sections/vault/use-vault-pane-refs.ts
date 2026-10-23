import { useRef } from "react";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/** Keep the vault's pane, focus and guide targets attached to the same elements. */
export function useVaultPaneRefs() {
  const detailRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const treePaneRef = useRef<HTMLDivElement>(null);
  const newItemRef = useRef<HTMLAnchorElement>(null);
  const createRef = useGuideTarget<HTMLAnchorElement>("vault.create");
  const listRef = useGuideTarget<HTMLDivElement>("vault.list");
  // A phone opens on the section tree, where the list pane is not drawn: the
  // tree answers to the list's target, and the Add button to the create one,
  // and the registry points at whichever copy is on screen.
  const treeListRef = useGuideTarget<HTMLDivElement>("vault.list");
  // Where New records itself for focus and the guide, wherever it is drawn.
  const recordNewItem = (element: HTMLAnchorElement | null) => {
    newItemRef.current = element;
    createRef(element);
  };

  return {
    detailRef,
    listPaneRef,
    treePaneRef,
    newItemRef,
    listRef,
    treeListRef,
    recordNewItem,
  };
}
