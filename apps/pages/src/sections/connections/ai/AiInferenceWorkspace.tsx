import { performSavedAiInference } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { isAiSpeechFamily } from "@opensesame/app-core/lib/ai-connections/types.js";
import { useCallback, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { AiOperationInput, useLocalAudioInput } from "./AudioFields.js";
import { predictionInputReady } from "./PredictionFields.js";
import { useAiOperation } from "./useAiConnection.js";

function useAiInference(connectionId: string) {
  const saved = readAiConnection(connectionId);
  const prediction = saved?.family === "replicate_predictions";
  const speech = isAiSpeechFamily(saved?.family);
  const audio = useLocalAudioInput();
  const clearAudio = audio.clear;
  const supportsStreaming =
    !saved?.vertex &&
    saved?.family !== "bedrock_converse" &&
    !prediction &&
    !speech;
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [stream, setStream] = useState(true);
  const withdraw = useCallback(() => {
    setPrompt("");
    setAnswer("");
    clearAudio();
  }, [clearAudio]);
  const pending = useAiOperation(() => {}, withdraw, connectionId);
  const ready = Boolean(
    saved &&
      (speech
        ? audio.fields.sampleAudio
        : prediction
          ? predictionInputReady(saved, prompt)
          : prompt.trim()),
  );
  async function invoke() {
    if (!ready) return;
    const draft = readAiConnection(connectionId);
    if (!draft) return;
    setAnswer("");
    await pending.runAi(async (owner, signal) => {
      const result = await performSavedAiInference(
        connectionId,
        speech
          ? {
              model: draft.model,
              messages: [],
              media: audio.fields.sampleAudio,
            }
          : {
              model: draft.model,
              messages: [{ role: "user", content: prompt }],
              maxOutputTokens: 1024,
            },
        { signal: owner.signal, assertCurrent: owner.check },
        stream && supportsStreaming
          ? (text) => {
              owner.check();
              setAnswer((current) => current + text);
            }
          : undefined,
        { signal },
      );
      owner.check();
      setAnswer(result.answer);
      return undefined;
    });
  }
  const change = (value: string) => {
    pending.clear();
    setPrompt(value);
    setAnswer("");
  };
  return {
    draft: saved,
    prediction,
    speech,
    audio: {
      ...audio.fields,
      onSampleAudio: (file: File | undefined) => {
        pending.clear();
        setAnswer("");
        audio.fields.onSampleAudio(file);
      },
    },
    onCancel: () => {
      if (speech) {
        pending.clear();
        clearAudio();
        setAnswer("");
      } else pending.onCancel();
    },
    supportsStreaming,
    prompt,
    answer,
    stream,
    setStream,
    pending,
    ready,
    invoke,
    change,
  };
}
export function AiInferenceWorkspace({
  connectionId,
}: { connectionId: string }) {
  const {
    draft,
    prediction,
    speech,
    audio,
    onCancel,
    supportsStreaming,
    prompt,
    answer,
    stream,
    setStream,
    pending,
    ready,
    invoke,
    change,
  } = useAiInference(connectionId);
  return (
    <section className="panel" aria-label="Model inference">
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span>{" "}
          {speech ? "Transcribe audio" : "Try this model"}
        </h2>
      </div>
      <div className="panel__body cx-form">
        <FailureNotice
          id={`ai-inference-${connectionId}`}
          title="Model inference"
          message={pending.failure}
        />
        <AiOperationInput
          draft={draft}
          busy={pending.busy}
          prompt={prompt}
          onPrompt={change}
          audio={audio}
        />
        {supportsStreaming ? (
          <label>
            <input
              type="checkbox"
              checked={stream}
              disabled={pending.busy}
              onChange={(event) => setStream(event.target.checked)}
            />{" "}
            Stream response
          </label>
        ) : (
          <p>Responses appear when the request completes.</p>
        )}
        <FormCommit
          label={
            speech
              ? "Transcribe audio"
              : prediction
                ? "Run prediction"
                : "Send prompt"
          }
          disabled={pending.busy || !ready}
          busy={pending.busy}
          onClick={() => void invoke()}
        >
          {(prediction || speech) && pending.busy ? (
            <IconKey
              label={speech ? "Cancel transcription" : "Cancel prediction"}
              onClick={onCancel}
            >
              <IconX size={16} />
            </IconKey>
          ) : null}
          {pending.failure ? (
            <StatusMark tone="err" label={pending.failure} />
          ) : null}
          {pending.result ? (
            <StatusMark tone="ok" label={pending.result} />
          ) : null}
        </FormCommit>
        <output
          aria-label={
            speech
              ? "Transcript"
              : prediction
                ? "Prediction output"
                : "Model answer"
          }
          aria-live="polite"
        >
          {answer}
        </output>
      </div>
    </section>
  );
}
