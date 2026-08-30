export type VaultKeymapTarget = {
  next: () => void;
  previous: () => void;
  first: () => void;
  last: () => void;
  enter: () => void;
  parent: () => void;
  activate: () => void;
  search: () => void;
  closeSearch: () => void;
  copySecret: () => void;
  copyUsername: () => void;
  edit: () => void;
  trash: () => void;
  create: () => void;
  favorite: () => void;
  share: () => void;
};

type KeymapOptions = {
  navigate: (path: string) => void;
  showHelp: () => void;
};

let vaultTarget: VaultKeymapTarget | null = null;

export function registerVaultKeymap(target: VaultKeymapTarget): () => void {
  vaultTarget = target;
  return () => {
    if (vaultTarget === target) vaultTarget = null;
  };
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

const SECTION_PATHS = new Map([
  ["v", "/vault"],
  ["c", "/connections"],
  ["a", "/access"],
  ["i", "/identity"],
  ["s", "/settings"],
]);

export function createKeymapHandler({ navigate, showHelp }: KeymapOptions) {
  let pendingGo = false;

  return (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      typing(event.target) ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    ) {
      pendingGo = false;
      return;
    }

    if (pendingGo) {
      pendingGo = false;
      if (event.key === "g") {
        vaultTarget?.first();
        event.preventDefault();
        return;
      }
      const path = SECTION_PATHS.get(event.key.toLowerCase());
      if (path) {
        navigate(path);
        event.preventDefault();
      }
      return;
    }

    if (event.key === "g") {
      pendingGo = true;
      event.preventDefault();
      return;
    }

    const target = vaultTarget;
    const action =
      event.key === "j" || event.key === "ArrowDown"
        ? target?.next
        : event.key === "k" || event.key === "ArrowUp"
          ? target?.previous
          : event.key === "l" || event.key === "ArrowRight"
            ? target?.enter
            : event.key === "h" || event.key === "ArrowLeft"
              ? target?.parent
              : event.key === "G"
                ? target?.last
                : event.key === "Enter"
                  ? target?.activate
                  : event.key === "/"
                    ? target?.search
                    : event.key === "Escape"
                      ? target?.closeSearch
                      : event.key === "y"
                        ? target?.copySecret
                        : event.key === "u"
                          ? target?.copyUsername
                          : event.key === "e"
                            ? target?.edit
                            : event.key === "x"
                              ? target?.trash
                              : event.key === "n"
                                ? target?.create
                                : event.key === "."
                                  ? target?.favorite
                                  : event.key === "s"
                                    ? target?.share
                                    : event.key === "?"
                                      ? showHelp
                                      : undefined;

    if (!action) return;
    action();
    event.preventDefault();
  };
}
