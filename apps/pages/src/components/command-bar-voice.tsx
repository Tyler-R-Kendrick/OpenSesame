import type { CommandVoiceProps } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  type SpeechDiagnostics,
  createPushToTalk,
  detectSpeechRecognition,
} from "@opensesame/app-core/lib/command-bar/speech.js";
import { voiceRecognitionLang } from "@opensesame/app-core/lib/model-provider.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerCommandBarMic } from "../lib/command-bar/focus.js";
import { MicButton } from "./command-bar-mic.js";

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
  if (!mic.speechOk) return null;
  return (
    <MicButton
      listening={mic.listening}
      disabled={busy || mic.talk === null}
      onToggle={() => void mic.onMicToggle()}
    />
  );
}

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

/** Why a finished press heard nothing, from what the engine reported. */
function silenceNotice(diag: SpeechDiagnostics): string {
  if (diag.lastError === "network")
    return "Speech engine needs network access in this browser (try Chrome or Edge).";
  if (isBlocked(diag.lastError))
    return "Microphone permission is blocked for this site.";
  if (!diag.started)
    return "Speech engine never started — try Chrome or Edge on localhost.";
  if (diag.results === 0)
    return "No speech heard. Allow the mic, speak while it is lit, then tap again.";
  return "Didn’t catch that — try speaking again.";
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
          setNotice(startErrorNotice(code));
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
      setNotice(silenceNotice(talk.diagnostics()));
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
