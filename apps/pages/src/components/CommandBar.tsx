import { executeCommand } from "@opensesame/app-core/lib/command-bar/execute.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useContributions } from "../bindings/contributions.js";
import { useCopySecret, useVault } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportIfMounted } from "../tutorial/support-access.js";
import { IconArrowRight } from "./Icons.js";
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
  // "Command or ask": a sentence no verb claims is a question, and the one
  // field in the chrome hands it to Support rather than shrugging. Support
  // learns whether a model exists only once it is opened, so an unknown
  // availability is still a road in; a known absence keeps the honest
  // no-match, because the sheet could only refuse the question again.
  const supportAccess = useSupportIfMounted();
  const availability = supportAccess?.view.availability ?? null;
  const canAsk =
    supportAccess !== null &&
    (availability === null || availability.kind === "ready") &&
    !supportAccess.view.thinking;
  const support = supportAccess?.support ?? null;

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
        const names = items
          .filter((item) => item.deletedAt === null)
          .map((item) => item.name);
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
    [assist, busy, canAsk, items, ports, support],
  );

  return {
    value,
    setValue,
    notice,
    setNotice,
    busy,
    run,
    Voice: assist?.Voice,
  };
}

/**
 * Shell omnibox — typed or spoken commands that drive navigation and
 * clipboard verbs. Click the mic to toggle listening; Enter submits.
 */
export function CommandBar() {
  const { value, setValue, notice, setNotice, busy, run, Voice } =
    useCommandRunner();
  const barRef = useGuideTarget<HTMLElement>("shell.command-bar");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run(value);
  };

  return (
    <search className="command-bar" ref={barRef}>
      <form className="command-bar__form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="command-bar-input">
          Command
        </label>
        <input
          id="command-bar-input"
          className="command-bar__input"
          type="text"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          placeholder="Command or ask… copy password for github"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        {Voice ? (
          <Voice
            setValue={setValue}
            setNotice={setNotice}
            run={run}
            busy={busy}
          />
        ) : null}
        <button
          type="submit"
          className="command-bar__go"
          aria-label="Run command"
          title="Run"
          disabled={busy || value.trim() === ""}
        >
          <IconArrowRight size={16} />
        </button>
      </form>
      {notice !== null ? (
        <output className="command-bar__status">{notice}</output>
      ) : null}
    </search>
  );
}
