import type { OwnedAiImage } from "@opensesame/app-core/lib/ai-connections/owned-image.js";
import { performSavedAiImageInference } from "@opensesame/app-core/lib/ai-connections/saved-image-runtime.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { AiGeneratedImage } from "./AiGeneratedImage.js";
import { useAiOperation } from "./useAiConnection.js";

function useImageGeneration(connectionId: string) {
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<OwnedAiImage | null>(null);
  const view = useMemo<{
    connectionId: string;
    current: AbortController | null;
  }>(() => ({ connectionId, current: null }), [connectionId]);
  const release = useCallback(() => {
    view.current?.abort();
    view.current = null;
    setImage(null);
  }, [view]);
  const withdraw = useCallback(() => {
    release();
    setPrompt("");
  }, [release]);
  const pending = useAiOperation(() => {}, withdraw, connectionId);
  useEffect(
    () => () => {
      view.current?.abort();
      view.current = null;
    },
    [view],
  );
  async function generate() {
    if (!prompt.trim() || pending.busy) return;
    release();
    const original = new AbortController();
    view.current = original;
    await pending.runAi(async (action) => {
      let result: OwnedAiImage | undefined;
      const checkView = () => {
        original.signal.throwIfAborted();
        if (view.current !== original)
          throw new Error("The image view was replaced.");
      };
      try {
        result = await performSavedAiImageInference(
          connectionId,
          prompt,
          { signal: original.signal, assertCurrent: checkView },
          { signal: action.signal, assertCurrent: action.check },
        );
        action.check();
        checkView();
        result.check();
        setImage(result);
        return undefined;
      } catch (error) {
        result?.release();
        original.abort();
        throw error;
      }
    });
  }
  const cancel = () => {
    pending.clear();
    withdraw();
  };
  return { prompt, setPrompt, image, pending, generate, cancel, release };
}

export function AiImageWorkspace({ connectionId }: { connectionId: string }) {
  const { prompt, setPrompt, image, pending, generate, cancel, release } =
    useImageGeneration(connectionId);
  return (
    <section className="panel" aria-label="Image generation">
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span> Generate an image
        </h2>
      </div>
      <div className="panel__body cx-form">
        <FailureNotice
          id={`ai-image-${connectionId}`}
          title="Image generation"
          message={pending.failure}
        />
        <FieldShell
          label="Image prompt"
          value={prompt}
          maxLength={8192}
          disabled={pending.busy}
          onValueChange={(value) => {
            pending.clear();
            release();
            setPrompt(value);
          }}
        />
        <p>
          Generation sends this prompt to your configured image service and may
          incur charges. Cancel stops local waiting; provider work or charges
          may continue.
        </p>
        <FormCommit
          label="Generate image"
          busy={pending.busy}
          disabled={pending.busy || !prompt.trim()}
          onClick={() => void generate()}
        >
          {pending.busy ? (
            <IconKey label="Cancel image generation" onClick={cancel}>
              <IconX size={16} />
            </IconKey>
          ) : null}
          {pending.failure ? (
            <StatusMark tone="err" label={pending.failure} />
          ) : null}
        </FormCommit>
        {image ? <AiGeneratedImage image={image} /> : null}
      </div>
    </section>
  );
}
