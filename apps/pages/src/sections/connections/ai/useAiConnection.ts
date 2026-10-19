import { bedrockResourceBase } from "@opensesame/app-core/lib/ai-connections/bedrock-target.js";
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
import { vertexResourceBase } from "@opensesame/app-core/lib/ai-connections/vertex-target.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

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
  changeVertexDraft(current, next, field);
  changeBedrockDraft(current, next, field);
  if (next.azure) {
    next.authentication = "api-key";
    if (next.azure.api === "dated-chat") {
      next.family = "openai_chat";
      if (current.azure?.api !== "dated-chat")
        next.tokenParameter = "max_tokens";
    }
  }
  if (
    (current.azure || next.azure) &&
    ["azure", "family", "baseUrl", "model"].includes(field)
  )
    next.apiKey = "";
  return next;
}
function changeVertexDraft(
  current: AiConnectionDraft,
  next: AiConnectionDraft,
  field: keyof AiConnectionDraft,
) {
  if (next.family !== "gemini_generate_content") next.vertex = undefined;
  if (next.vertex) {
    next.authentication = "api-key";
    const automatic =
      field === "vertex" &&
      (!next.baseUrl ||
        Boolean(
          current.vertex &&
            current.baseUrl === vertexResourceBase(current.vertex),
        ));
    if (next.providerId === "google-vertex" || automatic)
      next.baseUrl = vertexResourceBase(next.vertex);
  }
  if (
    (current.vertex || next.vertex) &&
    ["vertex", "family", "baseUrl", "model"].includes(field)
  )
    next.apiKey = "";
}
function changeBedrockDraft(
  current: AiConnectionDraft,
  next: AiConnectionDraft,
  field: keyof AiConnectionDraft,
) {
  if (next.family !== "bedrock_converse") next.bedrock = undefined;
  else {
    next.bedrock ??= { region: "us-east-1", credential: "sigv4" };
    next.authentication = "api-key";
    const automatic =
      !next.baseUrl ||
      Boolean(
        current.bedrock &&
          current.baseUrl.replace(/\/+$/, "") ===
            bedrockResourceBase(current.bedrock).replace(/\/$/, ""),
      );
    if (
      next.providerId === "aws-bedrock" ||
      ((field === "bedrock" || field === "family") && automatic)
    )
      next.baseUrl = bedrockResourceBase(next.bedrock);
  }
  if (
    (current.bedrock || next.bedrock) &&
    ["bedrock", "family", "baseUrl", "model"].includes(field)
  )
    next.apiKey = "";
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

function useAiFormOwner(
  generation: RefObject<number>,
  setDraft: Dispatch<SetStateAction<AiConnectionDraft>>,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setFailure: Dispatch<SetStateAction<string>>,
  setResult: Dispatch<SetStateAction<string>>,
) {
  useEffect(() => {
    const detach = vaultStore.onLock(() => {
      generation.current += 1;
      setDraft((current) => ({ ...current, apiKey: "" }));
      setBusy(false);
      setFailure("");
      setResult("");
    });
    return () => {
      generation.current += 1;
      detach();
    };
  }, [generation, setDraft, setBusy, setFailure, setResult]);
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
  useAiFormOwner(generation, setDraft, setBusy, setFailure, setResult);
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
