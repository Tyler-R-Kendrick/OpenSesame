import { performSavedAiInference } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { useEffect, useRef, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { StatusMark } from "../../../components/StatusMark.js";

export function AiInferenceWorkspace({
  connectionId,
}: { connectionId: string }) {
  const saved = readAiConnection(connectionId);
  const supportsStreaming =
    !saved?.vertex && saved?.family !== "bedrock_converse";
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState(true);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function invoke() {
    if (busy || !prompt.trim()) return;
    const draft = readAiConnection(connectionId);
    if (!draft) return;
    const lifetime = new AbortController();
    pending.current = lifetime;
    setBusy(true);
    setAnswer("");
    setFailure("");
    try {
      const result = await performSavedAiInference(
        connectionId,
        {
          model: draft.model,
          messages: [{ role: "user", content: prompt }],
          maxOutputTokens: 1024,
        },
        {
          signal: lifetime.signal,
          assertCurrent: () => lifetime.signal.throwIfAborted(),
        },
        stream && supportsStreaming
          ? (text) => setAnswer((current) => current + text)
          : undefined,
      );
      if (!lifetime.signal.aborted) setAnswer(result.answer);
    } catch (error) {
      if (!lifetime.signal.aborted)
        setFailure(
          error instanceof Error ? error.message : "The model request failed.",
        );
    } finally {
      if (!lifetime.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Model inference">
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span> Try this model
        </h2>
      </div>
      <div className="panel__body cx-form">
        <FailureNotice
          id={`ai-inference-${connectionId}`}
          title="Model inference"
          message={failure}
        />
        <FieldShell
          label="Prompt"
          value={prompt}
          disabled={busy}
          onValueChange={setPrompt}
        />
        {supportsStreaming ? (
          <label>
            <input
              type="checkbox"
              checked={stream}
              disabled={busy}
              onChange={(event) => setStream(event.target.checked)}
            />{" "}
            Stream response
          </label>
        ) : (
          <p>Responses appear when the request completes.</p>
        )}
        <FormCommit
          label="Send prompt"
          disabled={busy || !prompt.trim()}
          busy={busy}
          onClick={() => void invoke()}
        />
        {failure ? <StatusMark tone="err" label={failure} /> : null}
        <output aria-label="Model answer" aria-live="polite">
          {answer}
        </output>
      </div>
    </section>
  );
}
