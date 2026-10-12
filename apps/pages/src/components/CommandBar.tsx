import { executeCommand } from "@opensesame/app-core/lib/command-bar/execute.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import type { SlashSuggestion } from "@opensesame/app-core/lib/command-bar/slash.js";
import { listedItems } from "@opensesame/vault-core";
import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useContributions } from "../bindings/contributions.js";
import { useFieldSearch } from "../lib/command-bar/use-field-search.js";
import { useCopySecret, useVault } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import {
  COMMAND_LIST_ID,
  CommandSuggestions,
  commandOptionId,
  useCommandSuggestions,
} from "./CommandSuggestions.js";
import { IconArrowRight } from "./Icons.js";
import { useSupportRoad } from "./command-bar-support.js";
import { useCoarsePointer } from "./use-coarse-pointer.js";
import "./command-bar.css";

function useCommandRunner() {
  const navigate = useNavigate();
  // The on-device model reads what the parser cannot, when it is on.
  const [assist] = useContributions("command-assist");
  const copy = useCopySecret();
  const { items, status: vaultStatus } = useVault();
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { canAsk, support } = useSupportRoad(assist != null);

  const names = useMemo(
    () =>
      listedItems(items)
        .filter((item) => item.deletedAt === null)
        .map((item) => item.name),
    [items],
  );

  const ports = useMemo(
    () => ({
      navigate: (path: string) => navigate(path),
      copy,
      items: () => items,
      vaultLocked: () => vaultStatus !== "unlocked",
    }),
    [copy, items, navigate, vaultStatus],
  );

  const run = useCallback(
    async (utterance: string) => {
      const text = utterance.trim();
      if (text === "" || busy) return;
      setBusy(true);
      setNotice("Working…");
      try {
        const interpreted = assist
          ? await assist.interpret(text, { itemNames: names })
          : readCommand(text);
        if (interpreted.source === "none") {
          if (canAsk && support !== null) {
            support.open();
            void support.ask(text);
            setNotice(null);
            setValue("");
            return;
          }
          setNotice(interpreted.reason);
          return;
        }
        const outcome = await executeCommand(interpreted.command, ports);
        setNotice(outcome.message);
        if (outcome.ok) setValue("");
      } finally {
        setBusy(false);
      }
    },
    [assist, busy, canAsk, names, ports, support],
  );

  return {
    value,
    setValue,
    notice,
    setNotice,
    busy,
    run,
    names,
    input,
    Voice: assist?.Voice,
    asks: assist != null,
  };
}

/**
 * The field's hint. A phone's field is 178px wide at 320, so the desktop line
 * is cut mid-word there; its touch twin is the same three verbs, short enough
 * to be read whole (`verify:mobile` measures it at every width).
 */
export function commandPlaceholder(asks: boolean, touch: boolean): string {
  if (touch) return asks ? "Command or ask…" : "go · search · copy";
  return asks
    ? "Command or ask… copy password for github"
    : "go to vault · search · copy password for …";
}

/** The submit key; a search with no words yet has nothing to run. */
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

/**
 * Shell omnibox. With no model it runs parsed commands: navigate, search,
 * copy. A model adds interpretation, the mic, and the ask road.
 */
export function CommandBar() {
  const runner = useCommandRunner();
  const { value, setValue, notice, setNotice, busy, run, names } = runner;
  const touch = useCoarsePointer();
  const barRef = useGuideTarget<HTMLElement>("shell.command-bar");
  const suggestions = useCommandSuggestions(value, names);
  const search = useFieldSearch({
    value,
    setValue,
    // No stale notice from the last command, and the suggestions open again.
    onFill: () => {
      setNotice(null);
      suggestions.setDismissed(false);
    },
  });

  const choose = (suggestion: SlashSuggestion) => {
    setValue(suggestion.insert);
    if (!suggestion.run) {
      suggestions.setDismissed(false);
      return;
    }
    suggestions.setDismissed(true);
    void run(suggestion.insert);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    suggestions.setDismissed(true);
    if (search.live !== null) {
      search.commit();
      return;
    }
    void run(value);
  };

  return (
    <search className="command-bar" ref={barRef}>
      <form className="command-bar__form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="command-bar-input">
          Command
        </label>
        <input
          ref={runner.input}
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
          placeholder={commandPlaceholder(runner.asks, touch)}
          value={value}
          disabled={busy}
          onFocus={() => suggestions.setFocused(true)}
          onBlur={() => suggestions.setFocused(false)}
          onKeyDown={(event) =>
            search.onEscape(event, suggestions.open) ||
            suggestions.onKeyDown(event, choose)
          }
          onChange={(event) => {
            suggestions.setDismissed(false);
            setNotice(null);
            setValue(event.target.value);
          }}
        />
        {runner.Voice ? (
          <runner.Voice
            setValue={setValue}
            setNotice={setNotice}
            run={run}
            busy={busy}
          />
        ) : null}
        <RunKey off={busy || value.trim() === "" || search.empty} />
      </form>
      {suggestions.open ? (
        <CommandSuggestions
          suggestions={suggestions.suggestions}
          active={suggestions.active}
          onHover={suggestions.setActive}
          onChoose={choose}
        />
      ) : null}
      {notice !== null && !suggestions.open ? (
        <output className="command-bar__status">{notice}</output>
      ) : null}
    </search>
  );
}
