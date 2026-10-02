import {
  type SlashSuggestion,
  slashSections,
  slashSuggestions,
  suggestionKey,
} from "@opensesame/app-core/lib/command-bar/slash.js";
import { commandPathAuthorized } from "@opensesame/app-core/lib/command-bar/types.js";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useContributions } from "../bindings/contributions.js";

export const COMMAND_LIST_ID = "command-bar-suggestions";

export function commandOptionId(index: number): string {
  return `${COMMAND_LIST_ID}-${index}`;
}

/** Slash rows for the status-line field. Item names only — never a secret. */
export function useCommandSuggestions(value: string, names: readonly string[]) {
  const contributed = useContributions("command-path");
  const sections = useMemo(
    () => slashSections(contributed, commandPathAuthorized),
    [contributed],
  );
  const suggestions = useMemo(
    () => slashSuggestions(value, sections, names),
    [names, sections, value],
  );
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const signature = suggestions.map((row) => row.id).join("\0");
  const [cursor, setCursor] = useState({ signature, active: 0 });
  const active = cursor.signature === signature ? cursor.active : 0;
  if (cursor.signature !== signature) setCursor({ signature, active: 0 });

  const open = focused && !dismissed && suggestions.length > 0;

  return {
    suggestions,
    open,
    active,
    setActive(index: number) {
      setCursor({ signature, active: index });
    },
    setDismissed,
    setFocused,
    onKeyDown(
      event: KeyboardEvent<HTMLInputElement>,
      choose: (row: SlashSuggestion) => void,
    ) {
      if (event.nativeEvent.isComposing) return;
      const action = suggestionKey(event.key, open, suggestions, active);
      if (action.type === "none") return;
      event.preventDefault();
      if (action.type === "close") {
        setDismissed(true);
        return;
      }
      if (action.type === "move") {
        setCursor({ signature, active: action.index });
        return;
      }
      choose(action.suggestion);
    },
  };
}

/** Scroll the list itself. `scrollIntoView` would also move every ancestor. */
export function revealActiveOption(
  list: HTMLElement,
  option: HTMLElement,
): void {
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  const viewBottom = list.scrollTop + list.clientHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > viewBottom) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

export function CommandSuggestions({
  suggestions,
  active,
  onChoose,
  onHover,
}: {
  suggestions: readonly SlashSuggestion[];
  active: number;
  onChoose: (suggestion: SlashSuggestion) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const option = list?.children.item(active);
    if (list && option instanceof HTMLElement && suggestions.length > 0) {
      revealActiveOption(list, option);
    }
  }, [active, suggestions]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA combobox listbox not a native select
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input via aria-activedescendant
    <div
      role="listbox"
      ref={listRef}
      id={COMMAND_LIST_ID}
      className="command-bar__list"
      aria-label="Commands"
    >
      {suggestions.map((suggestion, index) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA combobox option under listbox
        // biome-ignore lint/a11y/useFocusableInteractive: options reached via aria-activedescendant on the input
        <div
          role="option"
          key={suggestion.id}
          id={commandOptionId(index)}
          aria-selected={index === active}
          className={
            index === active
              ? "command-bar__option is-active"
              : "command-bar__option"
          }
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onChoose(suggestion);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onChoose(suggestion);
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="command-bar__option-cmd">
            {suggestion.insert.trim()}
          </span>
          <span className="command-bar__option-label">{suggestion.label}</span>
        </div>
      ))}
    </div>
  );
}
