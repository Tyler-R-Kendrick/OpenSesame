import { executeCommand } from "@opensesame/app-core/lib/command-bar/execute.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import type { SlashSuggestion } from "@opensesame/app-core/lib/command-bar/slash.js";
import type { CommandVoiceProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  type ComponentType,
  type FormEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { FailureNotice } from "./FailureNotice.js";
import { IconArrowRight } from "./Icons.js";
import { StatusMark } from "./StatusMark.js";
import { useSupportRoad } from "./command-bar-support.js";
import { useCoarsePointer } from "./use-coarse-pointer.js";
import "./command-bar.css";

type CommandFailure = { message: string; tone: "err" };

function useCommandRunner() {
  const navigate = useNavigate();
  // The on-device model reads what the parser cannot, when it is on.
  const [assist] = useContributions("command-assist");
  const copy = useCopySecret();
  const { items, status: vaultStatus } = useVault();
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [busy, setBusy] = useState(false);
  // Stable: the voice bar keys its push-to-talk on this, and a new identity
  // each render would cancel a live press on the first interim result.
  const showNotice = useCallback((text: string | null) => {
    setFailure(null);
    setNotice(text);
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const { canAsk, support } = useSupportRoad(assist != null);

  const names = useMemo(
    () =>
      items.filter((item) => item.deletedAt === null).map((item) => item.name),
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
      setFailure(null);
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
        if (outcome.ok) {
          setNotice(outcome.message);
          setValue("");
        } else {
          setNotice(null);
          setFailure({ message: outcome.message, tone: "err" });
        }
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
    failure,
    setNotice: showNotice,
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

/** The failed command's mark, and the voice road when a model offers one. */
function CommandVoice({
  Voice,
  failure,
  ...props
}: CommandVoiceProps & {
  Voice: ComponentType<CommandVoiceProps> | undefined;
  failure: CommandFailure | null;
}) {
  return (
    <>
      {failure ? (
        <StatusMark tone={failure.tone} label={failure.message} />
      ) : null}
      {Voice ? <Voice {...props} /> : null}
    </>
  );
}

/** The quiet line under the field, and the tray's notice of a refusal. */
function CommandStatus({
  notice,
  failure,
}: {
  notice: string | null;
  failure: CommandFailure | null;
}) {
  return (
    <>
      {notice !== null ? (
        <output className="command-bar__status">{notice}</output>
      ) : null}
      <FailureNotice
        id="command-bar:error"
        title="Command"
        message={failure?.message ?? null}
        tone={failure?.tone}
      />
    </>
  );
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
  const { value, setValue, notice, failure, setNotice, busy, run, names } =
    runner;
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
          aria-invalid={failure !== null ? true : undefined}
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
        <CommandVoice
          Voice={runner.Voice}
          failure={failure}
          setValue={setValue}
          setNotice={setNotice}
          run={run}
          busy={busy}
        />
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
      <CommandStatus
        notice={suggestions.open ? null : notice}
        failure={failure}
      />
    </search>
  );
}
