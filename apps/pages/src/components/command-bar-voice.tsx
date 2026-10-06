import type { CommandVoiceProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  type SpeechDiagnostics,
  createPushToTalk,
  detectSpeechRecognition,
} from "@opensesame/app-core/lib/command-bar/speech.js";
import { voiceRecognitionLang } from "@opensesame/app-core/lib/model-provider.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerCommandBarMic } from "../lib/command-bar/focus.js";
import { FailureNotice } from "./FailureNotice.js";
import { StatusMark } from "./StatusMark.js";
import { MicButton } from "./command-bar-mic.js";
import { useCoarsePointer } from "./use-coarse-pointer.js";

/**
 * The command bar's voice input — `support.local-ai`'s, contributed through
 * `command-assist` with the model that reads what it hears. Push to talk:
 * the mic starts listening, a second press runs what was heard.
 */
export function CommandBarVoice({
  setValue,
  setNotice,
  run,
  busy,
}: CommandVoiceProps) {
  const mic = useVoiceListenBar(setValue, setNotice, run, busy);
  return (
    <>
      {mic.speechOk ? (
        <MicButton
          listening={mic.listening}
          disabled={busy || mic.talk === null}
          onToggle={() => void mic.onMicToggle()}
        />
      ) : null}
      {mic.failure ? (
        <StatusMark tone={mic.failure.tone} label={mic.failure.message} />
      ) : null}
      <FailureNotice
        id="command-bar:voice"
        title="Voice input"
        message={mic.failure?.message}
        tone={mic.failure?.tone}
      />
    </>
  );
}

/** A press that failed: the mic key's mark and the tray's notice. */
type VoiceFailure = { message: string; tone: "warn" | "err" };

function isBlocked(code: string | null): boolean {
  return code === "not-allowed" || code === "service-not-allowed";
}

/** Why listening could not start, in the person's words. */
function startErrorNotice(code: string): string {
  if (isBlocked(code)) return "Microphone permission is blocked for this site.";
  if (code === "network")
    return "Speech recognition needs a network path in this browser.";
  return "Couldn’t start listening — try again.";
}

/** What a press that heard nothing tells the person, and where it goes. */
type Silence = { message: string; failed: boolean };

/**
 * What a finished press that heard nothing asks of the person. An engine that
 * cannot run is a failure (the tray); "speak again" is guidance, and stays in
 * the bar's status line.
 */
function silence(diag: SpeechDiagnostics): Silence {
  if (diag.lastError === "network")
    return {
      message:
        "Speech engine needs network access in this browser (try Chrome or Edge).",
      failed: true,
    };
  if (isBlocked(diag.lastError))
    return {
      message: "Microphone permission is blocked for this site.",
      failed: true,
    };
  if (!diag.started)
    return {
      message: "Speech engine never started — try Chrome or Edge on localhost.",
      failed: true,
    };
  if (diag.results === 0)
    return {
      message:
        "No speech heard. Allow the mic, speak while it is lit, then tap again.",
      failed: false,
    };
  return {
    message: "Didn’t catch that — try speaking again.",
    failed: false,
  };
}

/** What a press that ended with words in the field asks of the person. */
function endedNotice(touch: boolean): string {
  return touch
    ? "Listening ended — tap the arrow to run, or tap mic again."
    : "Listening ended — press Enter to run, or tap mic again.";
}

/** Escape while listening abandons the press. */
function useEscapeToCancel(listening: boolean, onCancel: () => void) {
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, onCancel]);
}

function useVoiceListenBar(
  setValue: (text: string) => void,
  setNotice: (text: string | null) => void,
  run: (utterance: string) => Promise<void>,
  busy: boolean,
) {
  const [listening, setListening] = useState(false);
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const listeningRef = useRef(false);
  const draftRef = useRef("");
  const speechOk = detectSpeechRecognition() !== null;
  // The same reactive read the placeholder uses, so a hybrid device cannot
  // show one voice in the field and the other in the notice. A ref keeps the
  // recogniser from being rebuilt when the pointer changes mid-listen.
  const touch = useCoarsePointer();
  const touchRef = useRef(touch);
  touchRef.current = touch;
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
            setNotice(endedNotice(touchRef.current));
            return;
          }
          setNotice("Listening ended before speech. Tap mic, then speak.");
        },
        onError: (code) => {
          listeningRef.current = false;
          setListening(false);
          setNotice(null);
          setFailure({ message: startErrorNotice(code), tone: "err" });
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
      const heard = silence(talk.diagnostics());
      if (heard.failed) {
        setNotice(null);
        setFailure({ message: heard.message, tone: "err" });
      } else {
        setNotice(heard.message);
      }
      return;
    }
    draftRef.current = "";
    setFailure(null);
    talk.press();
    listeningRef.current = true;
    setListening(true);
    setNotice("Listening… tap the mic again when done.");
  }, [busy, run, setNotice, setValue, talk]);

  useEffect(
    () => registerCommandBarMic(() => void onMicToggle()),
    [onMicToggle],
  );

  const cancelListening = useCallback(() => {
    talk?.cancel();
    listeningRef.current = false;
    draftRef.current = "";
    setListening(false);
    setNotice("Listening cancelled.");
  }, [setNotice, talk]);
  useEscapeToCancel(listening, cancelListening);

  return {
    speechOk,
    listening,
    talk,
    failure,
    onMicToggle,
  };
}
