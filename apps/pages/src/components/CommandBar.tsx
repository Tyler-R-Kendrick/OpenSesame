import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { executeCommand } from "../lib/command-bar/execute.js";
import { registerCommandBarMic } from "../lib/command-bar/focus.js";
import { interpretCommand } from "../lib/command-bar/interpret.js";
import {
  createPushToTalk,
  detectSpeechRecognition,
} from "../lib/command-bar/speech.js";
import { voiceRecognitionLang } from "../lib/model-provider.js";
import { useCopySecret, useVault } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportIfMounted } from "../tutorial/support-access.js";
import { IconArrowRight } from "./Icons.js";
import { MicButton } from "./command-bar-mic.js";
import "./command-bar.css";

function useCommandRunner() {
  const navigate = useNavigate();
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
        const interpreted = await interpretCommand(text, { itemNames: names });
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
    [busy, canAsk, items, ports, support],
  );

  return { value, setValue, notice, setNotice, busy, run };
}

function useVoiceListenBar(
  setValue: (text: string) => void,
  setNotice: (text: string | null) => void,
  run: (utterance: string) => Promise<void>,
  busy: boolean,
) {
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const draftRef = useRef("");
  const speechOk = detectSpeechRecognition() !== null;
  const talk = useMemo(
    () =>
      createPushToTalk({
        lang: () => voiceRecognitionLang(),
        onInterim: (text) => {
          draftRef.current = text;
          setValue(text);
        },
        onEngineEnd: (text) => {
          listeningRef.current = false;
          setListening(false);
          if (text.trim() !== "") {
            draftRef.current = text;
            setValue(text);
            setNotice(
              "Listening ended — press Enter to run, or tap mic again.",
            );
            return;
          }
          setNotice("Listening ended before speech. Tap mic, then speak.");
        },
        onError: (code) => {
          listeningRef.current = false;
          setListening(false);
          if (code === "not-allowed" || code === "service-not-allowed") {
            setNotice("Microphone permission is blocked for this site.");
            return;
          }
          if (code === "network") {
            setNotice(
              "Speech recognition needs a network path in this browser.",
            );
            return;
          }
          setNotice("Couldn’t start listening — try again.");
        },
      }),
    [setNotice, setValue],
  );

  useEffect(() => () => talk?.cancel(), [talk]);

  const onMicToggle = useCallback(async () => {
    if (talk === null || busy) return;
    if (listeningRef.current) {
      listeningRef.current = false;
      setListening(false);
      const released = await talk.release();
      const text = (released !== "" ? released : draftRef.current).trim();
      draftRef.current = "";
      if (text !== "") {
        setValue(text);
        await run(text);
        return;
      }
      const diag = talk.diagnostics();
      if (diag.lastError === "network") {
        setNotice(
          "Speech engine needs network access in this browser (try Chrome or Edge).",
        );
        return;
      }
      if (
        diag.lastError === "not-allowed" ||
        diag.lastError === "service-not-allowed"
      ) {
        setNotice("Microphone permission is blocked for this site.");
        return;
      }
      if (!diag.started) {
        setNotice(
          "Speech engine never started — try Chrome or Edge on localhost.",
        );
        return;
      }
      if (diag.results === 0) {
        setNotice(
          "No speech heard. Allow the mic, speak while it is lit, then tap again.",
        );
        return;
      }
      setNotice("Didn’t catch that — try speaking again.");
      return;
    }
    draftRef.current = "";
    talk.press();
    listeningRef.current = true;
    setListening(true);
    setNotice("Listening… tap the mic again when done.");
  }, [busy, run, setNotice, setValue, talk]);

  useEffect(
    () => registerCommandBarMic(() => void onMicToggle()),
    [onMicToggle],
  );

  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      talk?.cancel();
      listeningRef.current = false;
      draftRef.current = "";
      setListening(false);
      setNotice("Listening cancelled.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, setNotice, talk]);

  return {
    speechOk,
    listening,
    talk,
    onMicToggle,
  };
}

/**
 * Shell omnibox — typed or spoken commands that drive navigation and
 * clipboard verbs. Click the mic to toggle listening; Enter submits.
 */
export function CommandBar() {
  const { value, setValue, notice, setNotice, busy, run } = useCommandRunner();
  const mic = useVoiceListenBar(setValue, setNotice, run, busy);
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
        {mic.speechOk ? (
          <MicButton
            listening={mic.listening}
            disabled={busy || mic.talk === null}
            onToggle={() => void mic.onMicToggle()}
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
