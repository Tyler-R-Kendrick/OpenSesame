import type { SuggestOption } from "@opensesame/app-core/lib/vault/path-suggest.js";
import { IconPlus } from "../../components/Icons.js";
import { type SegmentSource, usePathSegment } from "./use-path-segment.js";

/**
 * One special part of the title row — the folder before the name, the file
 * type after it — as an editable combobox that only ever holds a value from
 * its list (the APG editable combobox with list autocomplete).
 *
 * It shows what is chosen. Clicking it, typing in it or ArrowDown opens the
 * list; typing narrows the list (a prefix first, then any folder-name segment,
 * then any substring) and the best match is already highlighted, so Enter —
 * or Tab on the way out — takes it. Text that is not on the list is never kept:
 * leaving the field with something that names no row puts back what was chosen,
 * and one that names a row exactly chooses it. Focus alone opens nothing, so
 * tabbing through the title row does not flash a menu at every stop.
 */
export function PathSegment({
  label,
  tone,
  maxLength,
  onPicked,
  ...source
}: Omit<SegmentSource, "onPicked"> & {
  label: string;
  tone: "folder" | "type";
  maxLength: number;
  onPicked?: () => void;
}) {
  const state = usePathSegment({ ...source, onPicked });
  return (
    <span className={`pathfield__seg pathfield__seg--${tone}`}>
      <input
        className="pathfield__input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={state.expanded}
        aria-controls={state.listId}
        aria-activedescendant={state.activeId}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={maxLength}
        value={state.shown}
        title={state.shown}
        // The text's own width, plus both paddings and a hair for the caret.
        style={{
          width: `calc(${Math.max(state.shown.length, 1)}ch + 1.25rem)`,
        }}
        {...state.input}
      />
      {state.expanded ? (
        <SegmentList
          label={label}
          tone={tone}
          listId={state.listId}
          options={state.options}
          at={state.at}
          onHover={state.setActive}
          onTake={state.take}
        />
      ) : null}
    </span>
  );
}

function SegmentList({
  label,
  tone,
  listId,
  options,
  at,
  onHover,
  onTake,
}: {
  label: string;
  tone: "folder" | "type";
  listId: string;
  options: SuggestOption[];
  at: number;
  onHover: (index: number) => void;
  onTake: (option: SuggestOption) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA combobox listbox, not a native select
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the input via aria-activedescendant
    <div
      role="listbox"
      id={listId}
      aria-label={`${label} choices`}
      className={`pathfield__list pathfield__list--${tone}`}
      // Keep focus in the field while the list is pressed, scrolled or dragged.
      onMouseDown={(event) => event.preventDefault()}
    >
      {options.map((option, index) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA combobox option under listbox
        // biome-ignore lint/a11y/useFocusableInteractive: options are reached via aria-activedescendant
        <div
          role="option"
          key={option.key}
          id={`${listId}-${index}`}
          data-key={option.key}
          className={`pathfield__option${index === at ? " is-active" : ""}`}
          aria-selected={index === at}
          aria-label={option.adding ? `New folder ${option.label}` : undefined}
          onMouseDown={() => onTake(option)}
          onMouseEnter={() => onHover(index)}
        >
          {option.adding ? <IconPlus size={13} /> : null}
          <span className="pathfield__label">{option.label}</span>
          {option.detail ? (
            <span className="pathfield__detail">{option.detail}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
