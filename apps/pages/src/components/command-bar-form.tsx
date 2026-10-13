import type { SlashSuggestion } from "@opensesame/app-core/lib/command-bar/slash.js";
import type { ComponentType, FormEvent, RefObject } from "react";
import { useFieldSearch } from "../lib/command-bar/use-field-search.js";
import { commandPlaceholder } from "./command-bar-placeholder.js";
import {
  COMMAND_LIST_ID,
  commandOptionId,
  useCommandSuggestions,
} from "./CommandSuggestions.js";
import { IconArrowRight } from "./Icons.js";

function RunKey({ off }: { off: boolean }) {
  return (
    <button
      type="submit"
      className="command-bar__go"
      aria-label="Run command"
      title="Run"
      disabled={off}
    >
      <IconArrowRight size={16} />
    </button>
  );
}

export function CommandBarForm({
  inputRef,
  value,
  setValue,
  notice,
  setNotice,
  busy,
  run,
  asks,
  touch,
  search,
  suggestions,
  choose,
  onSubmit,
  Voice,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  setValue: (next: string) => void;
  notice: string | null;
  setNotice: (next: string | null) => void;
  busy: boolean;
  run: (utterance: string) => Promise<void>;
  asks: boolean;
  touch: boolean;
  search: ReturnType<typeof useFieldSearch>;
  suggestions: ReturnType<typeof useCommandSuggestions>;
  choose: (suggestion: SlashSuggestion) => void;
  onSubmit: (event: FormEvent) => void;
  Voice?: ComponentType<{
    setValue: (next: string) => void;
    setNotice: (next: string | null) => void;
    run: (utterance: string) => Promise<void>;
    busy: boolean;
  }>;
}) {
  return (
    <form className="command-bar__form" onSubmit={onSubmit}>
      <label className="visually-hidden" htmlFor="command-bar-input">
        Command
      </label>
      <input
        ref={inputRef}
        id="command-bar-input"
        className="command-bar__input"
        type="text"
        role="combobox"
        enterKeyHint="go"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={suggestions.open}
        aria-controls={suggestions.open ? COMMAND_LIST_ID : undefined}
        aria-activedescendant={
          suggestions.open ? commandOptionId(suggestions.active) : undefined
        }
        placeholder={commandPlaceholder(asks, touch)}
        value={value}
        disabled={busy}
        onFocus={() => suggestions.setFocused(true)}
        onBlur={() => suggestions.setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && notice !== null) {
            event.preventDefault();
            setNotice(null);
            return;
          }
          if (
            search.onEscape(event, suggestions.open) ||
            suggestions.onKeyDown(event, choose)
          ) {
            return;
          }
        }}
        onChange={(event) => {
          suggestions.setDismissed(false);
          setNotice(null);
          setValue(event.target.value);
        }}
      />
      {Voice ? (
        <Voice
          setValue={setValue}
          setNotice={setNotice}
          run={run}
          busy={busy}
        />
      ) : null}
      <RunKey off={busy || value.trim() === "" || search.empty} />
    </form>
  );
}
