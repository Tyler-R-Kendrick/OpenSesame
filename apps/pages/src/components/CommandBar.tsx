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
  CommandSuggestions,
  useCommandSuggestions,
} from "./CommandSuggestions.js";
import { CommandBarForm } from "./command-bar-form.js";
import { CommandBarNotice } from "./command-bar-notice.js";
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

export { commandPlaceholder } from "./command-bar-placeholder.js";

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
      <CommandBarForm
        inputRef={runner.input}
        value={value}
        setValue={setValue}
        notice={notice}
        setNotice={setNotice}
        busy={busy}
        run={run}
        asks={runner.asks}
        touch={touch}
        search={search}
        suggestions={suggestions}
        choose={choose}
        onSubmit={onSubmit}
        Voice={runner.Voice}
      />
      {suggestions.open ? (
        <CommandSuggestions
          suggestions={suggestions.suggestions}
          active={suggestions.active}
          onHover={suggestions.setActive}
          onChoose={choose}
        />
      ) : null}
      <CommandBarNotice
        notice={notice}
        setNotice={setNotice}
        open={suggestions.open}
      />
    </search>
  );
}
