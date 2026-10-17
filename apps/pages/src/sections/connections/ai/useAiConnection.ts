import {
  aiConnectionBinding,
  validateAiConnection,
} from "@opensesame/app-core/lib/ai-connections/configuration.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  deleteAiConnection,
  saveAiConnection,
  testAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useRef, useState } from "react";

export const aiConnectionUiDependencies = {
  save: saveAiConnection,
  test: testAiConnection,
  remove: deleteAiConnection,
};

function initialDraft(providerId: string, id?: string) {
  return id
    ? (readAiConnection(id) ?? aiConnectionDraft(providerId))
    : aiConnectionDraft(providerId);
}
function changeDraft<Key extends keyof AiConnectionDraft>(
  current: AiConnectionDraft,
  field: Key,
  value: AiConnectionDraft[Key],
) {
  const next = { ...current, [field]: value };
  if (!["openai_chat", "openai_responses"].includes(next.family))
    next.azure = undefined;
  if (next.azure) {
    next.authentication = "api-key";
    if (next.azure.api === "dated-chat") next.family = "openai_chat";
  }
  if (
    (current.azure || next.azure) &&
    ["azure", "family", "baseUrl", "model"].includes(field)
  )
    next.apiKey = "";
  return next;
}
function canRetainCredential(draft: AiConnectionDraft, id?: string): boolean {
  if (!id) return false;
  try {
    const saved = readAiConnection(id);
    return Boolean(
      saved &&
        aiConnectionBinding(validateAiConnection(draft, false)) ===
          aiConnectionBinding(validateAiConnection(saved, false)),
    );
  } catch {
    return false;
  }
}

export function useAiConnection(
  providerId: string,
  connectionId: string | undefined,
  onFlash: (flash: Flash) => void,
  onSaved?: () => void,
) {
  const [draft, setDraft] = useState(() =>
    initialDraft(providerId, connectionId),
  );
  const [savedId, setSavedId] = useState(connectionId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  function onChange<Key extends keyof AiConnectionDraft>(
    field: Key,
    value: AiConnectionDraft[Key],
  ) {
    setDraft((current) => changeDraft(current, field, value));
    setFailure("");
    setResult("");
  }
  async function run(save: boolean) {
    if (busy) return;
    const started = ++generation.current;
    setBusy(true);
    setFailure("");
    setResult("");
    try {
      if (save) {
        const view = await aiConnectionUiDependencies.save(draft, savedId);
        if (started !== generation.current) return;
        setSavedId(view.connectionId);
        setDraft((current) => ({ ...current, apiKey: "" }));
        setResult("AI connection verified and saved in this vault");
        window.dispatchEvent(new Event("opensesame:ai-connections-changed"));
        onSaved?.();
      } else {
        const label = await aiConnectionUiDependencies.test(draft, savedId);
        if (started !== generation.current) return;
        setResult(label);
      }
    } catch (error) {
      if (started !== generation.current) return;
      const text =
        error instanceof Error ? error.message : "The AI operation failed.";
      const safe = draft.apiKey
        ? text.replaceAll(draft.apiKey, "[credential]")
        : text;
      setFailure(safe);
      onFlash({ tone: "err", text: safe });
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }

  async function onForget() {
    if (busy || !savedId) return;
    const started = ++generation.current;
    setBusy(true);
    setFailure("");
    try {
      await aiConnectionUiDependencies.remove(savedId);
      if (started !== generation.current) return;
      setSavedId(undefined);
      setResult("AI connection forgotten");
      window.dispatchEvent(new Event("opensesame:ai-connections-changed"));
      onSaved?.();
    } catch (error) {
      if (started !== generation.current) return;
      const text =
        error instanceof Error
          ? error.message
          : "Could not forget this AI connection.";
      setFailure(text);
      onFlash({ tone: "err", text });
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }
  return {
    draft,
    savedId,
    hasSavedCredentials: Boolean(savedId && readAiConnection(savedId)),
    canRetainCredential: canRetainCredential(draft, savedId),
    busy,
    failure,
    result,
    onChange,
    onSave: () => void run(true),
    onTest: () => void run(false),
    onForget: () => void onForget(),
  };
}
