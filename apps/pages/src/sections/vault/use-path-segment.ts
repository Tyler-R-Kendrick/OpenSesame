import type { SuggestOption } from "@opensesame/app-core/lib/vault/path-suggest.js";
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { handleSegmentKey } from "./path-segment-keys.js";

export type SegmentSource = {
  /** What is chosen now, as it reads in the row. */
  text: string;
  suggest: (query: string) => SuggestOption[];
  exact: (query: string) => SuggestOption | undefined;
  onPick: (key: string) => void;
  /** After a row is taken: where the caret goes next. */
  onPicked: (() => void) | undefined;
};

/**
 * The state and keys of one editable combobox over a closed list
 * (`PathSegment`). `query` is what the person has typed since the field was
 * entered — `null` while it shows the chosen value — and the list is open only
 * after a click, typing or ArrowDown, never from focus alone.
 */
export function usePathSegment(source: SegmentSource) {
  const { text, suggest, exact, onPick, onPicked } = source;
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const justFocused = useRef(false);
  const leaving = useRef(false);

  const options = open ? suggest(query ?? "") : [];
  const at = Math.min(active, Math.max(options.length - 1, 0));
  const expanded = open && options.length > 0;
  const activeId = expanded ? `${listId}-${at}` : undefined;
  const pick = options[at];

  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function show() {
    if (query === null) {
      const current = suggest("").findIndex((option) => option.label === text);
      setActive(Math.max(current, 0));
    }
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function take(option: SuggestOption, byTab = false) {
    // On the way out by Tab the blur that follows must not choose again.
    leaving.current = byTab;
    setQuery(null);
    setOpen(false);
    onPick(option.key);
    onPicked?.();
  }

  function onBlur() {
    justFocused.current = false;
    setOpen(false);
    const typed = query;
    setQuery(null);
    if (leaving.current) {
      leaving.current = false;
      return;
    }
    const hit = typed === null ? undefined : exact(typed);
    if (hit && hit.label !== text) onPick(hit.key);
  }

  return {
    listId,
    shown: query ?? text,
    options,
    at,
    expanded,
    activeId,
    setActive,
    take,
    input: {
      onFocus: (event: FocusEvent<HTMLInputElement>) => {
        justFocused.current = true;
        event.currentTarget.select();
      },
      // The click that focuses the field would drop the selection it just
      // made, and typing would then append to the chosen value.
      onMouseUp: (event: MouseEvent<HTMLInputElement>) => {
        if (!justFocused.current) return;
        justFocused.current = false;
        event.preventDefault();
      },
      onClick: show,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        setQuery(event.target.value);
        setActive(0);
        setOpen(true);
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) =>
        handleSegmentKey(event, {
          open,
          expanded,
          options,
          at,
          pick,
          query,
          text,
          show,
          close,
          highlight: setActive,
          take,
        }),
      onBlur,
    },
  };
}
