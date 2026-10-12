import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type BranchChoices = {
  choices: ReadonlyMap<string, boolean>;
  toggle: (href: string) => void;
};
const Expansion = createContext<BranchChoices | null>(null);

/** A shell's category choices outlive its phone record panes, never its vault session. */
export function PageTreeExpansionProvider({
  children,
}: { children: ReactNode }) {
  const [choices, setChoices] = useState(() => new Map<string, boolean>());
  const toggle = useCallback((href: string) => {
    setChoices((before) => new Map(before).set(href, !before.get(href)));
  }, []);
  const value = useMemo(() => ({ choices, toggle }), [choices, toggle]);
  return <Expansion.Provider value={value}>{children}</Expansion.Provider>;
}

export function usePageBranchExpand(href: string) {
  const shared = useContext(Expansion);
  const [local, setLocal] = useState(false);
  return {
    expanded: shared ? (shared.choices.get(href) ?? false) : local,
    toggle: () => (shared ? shared.toggle(href) : setLocal((open) => !open)),
  };
}
