import {
  type AiAudioInput,
  MAX_AI_AUDIO_INPUT_BYTES,
  validateAiAudio,
} from "@opensesame/app-core/lib/ai-connections/media.js";
import {
  type AiConnectionDraft,
  isAiSpeechFamily,
} from "@opensesame/app-core/lib/ai-connections/types.js";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { PredictionInput } from "./PredictionFields.js";
export type AudioFieldProps = {
  sampleAudio?: AiAudioInput;
  sampleLabel?: string;
  sampleFailure?: string;
  onSampleAudio?: (file: File | undefined) => void;
};
function readLocalAudio(file: File, reader: FileReader): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer))
        reject(new Error("Unreadable local audio"));
      else resolve(new Uint8Array(result));
    };
    reader.onerror = reader.onabort = () =>
      reject(new Error("Local audio read ended"));
    reader.readAsArrayBuffer(file);
  });
}
/** Local file reads own no network authority and cannot outlive their selected input. */
export function useLocalAudioInput() {
  const [sampleAudio, setSampleAudio] = useState<AiAudioInput>();
  const [sampleLabel, setSampleLabel] = useState("");
  const [sampleFailure, setSampleFailure] = useState("");
  const epoch = useRef(0);
  const reader = useRef<FileReader | null>(null);
  const clear = useCallback(() => {
    epoch.current++;
    reader.current?.abort();
    reader.current = null;
    setSampleAudio(undefined);
    setSampleLabel("");
    setSampleFailure("");
  }, []);
  useLayoutEffect(
    () => () => {
      epoch.current++;
      reader.current?.abort();
      reader.current = null;
    },
    [],
  );
  const onSampleAudio = useCallback(
    (file: File | undefined) => {
      clear();
      const turn = epoch.current;
      if (!file) return;
      void (async () => {
        let current: FileReader | undefined;
        try {
          if (!file.size || file.size > MAX_AI_AUDIO_INPUT_BYTES)
            throw new Error("Local audio size bound");
          current = new FileReader();
          reader.current = current;
          const bytes = await readLocalAudio(file, current);
          if (turn !== epoch.current) return;
          const audio = validateAiAudio({ mimeType: file.type, bytes });
          setSampleAudio(audio);
          setSampleLabel(file.name);
        } catch {
          if (turn === epoch.current)
            setSampleFailure(
              "Choose a recognized local audio file within the 1 MiB recording/upload bound.",
            );
        } finally {
          if (reader.current === current) reader.current = null;
        }
      })();
    },
    [clear],
  );
  return {
    clear,
    fields: { sampleAudio, sampleLabel, sampleFailure, onSampleAudio },
  };
}
export function AudioSampleField({
  busy,
  label,
  sampleLabel,
  sampleFailure,
  onSampleAudio,
}: AudioFieldProps & { busy: boolean; label: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!sampleLabel && input.current) input.current.value = "";
  }, [sampleLabel]);
  return (
    <>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          ref={input}
          id={id}
          type="file"
          accept="audio/wav,audio/webm,audio/ogg,audio/mp4,audio/mpeg"
          disabled={busy}
          onChange={(event) => onSampleAudio?.(event.target.files?.[0])}
        />
      </div>
      {sampleLabel ? (
        <FieldShell label="Selected audio" value={sampleLabel} readOnly />
      ) : null}
      {sampleFailure ? <StatusMark tone="err" label={sampleFailure} /> : null}
    </>
  );
}

export function AiOperationInput({
  draft,
  busy,
  prompt,
  onPrompt,
  audio,
}: {
  draft: AiConnectionDraft | null;
  busy: boolean;
  prompt: string;
  onPrompt: (value: string) => void;
  audio: AudioFieldProps;
}) {
  if (isAiSpeechFamily(draft?.family))
    return (
      <AudioSampleField {...audio} busy={busy} label="Audio to transcribe" />
    );
  if (draft?.family === "replicate_predictions")
    return (
      <PredictionInput
        label="Prediction input JSON"
        value={prompt}
        busy={busy}
        onChange={onPrompt}
      />
    );
  return (
    <FieldShell
      label="Prompt"
      value={prompt}
      disabled={busy}
      onValueChange={onPrompt}
    />
  );
}
