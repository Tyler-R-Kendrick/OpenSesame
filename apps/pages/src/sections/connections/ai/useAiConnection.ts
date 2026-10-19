import { bedrockResourceBase } from "@opensesame/app-core/lib/ai-connections/bedrock-target.js";
import {
  aiConnectionBinding,
  validateAiConnection,
} from "@opensesame/app-core/lib/ai-connections/configuration.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { ReplicatePredictionInterrupted } from "@opensesame/app-core/lib/ai-connections/replicate-types.js";
import {
  deleteAiConnection,
  saveAiConnection,
  testAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import { vertexResourceBase } from "@opensesame/app-core/lib/ai-connections/vertex-target.js";
import { subscribeDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  type SecretBackendActionOwner,
  useSecretBackendAction,
} from "../secret-backends/useSecretBackendAction.js";
import { useLocalAudioInput } from "./AudioFields.js";
import { replicateVerificationInput } from "./PredictionFields.js";

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
  if (["replicate_predictions", "elevenlabs_scribe"].includes(next.family))
    next.authentication = "api-key";
  if (
    (["replicate_predictions", "elevenlabs_scribe"].includes(current.family) ||
      ["replicate_predictions", "elevenlabs_scribe"].includes(next.family)) &&
    ["family", "baseUrl", "model", "authentication"].includes(field)
  )
    next.apiKey = "";
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

function aiVaultScope() {
  const snapshot = vaultStore.getSnapshot();
  return JSON.stringify([
    snapshot.status,
    snapshot.tomb,
    snapshot.guest,
    snapshot.awaitingSecondStep,
    snapshot.decoy,
  ]);
}
function savedStamp(id?: string) {
  const row = id ? readNativeConnector(id) : null;
  return JSON.stringify([row?.revision, row?.fingerprint]);
}
/** Shared action ownership ends HTTP. Only the separate user controller requests cancellation. */
export function useAiOperation(
  onFlash: (flash: Flash) => void,
  onWithdraw: () => void,
  connectionId?: string,
) {
  const action = useSecretBackendAction(onFlash);
  const prediction = useRef<AbortController | null>(null);
  const { clear } = action;
  useLayoutEffect(() => {
    let scope = aiVaultScope();
    let stamp = savedStamp(connectionId);
    const end = () => {
      clear();
      onWithdraw();
    };
    const stopLock = vaultStore.onLock(end);
    const stopVault = vaultStore.subscribe(() => {
      const next = aiVaultScope();
      if (next !== scope) {
        scope = next;
        end();
      }
    });
    const stopRows = subscribeDeviceRows(() => {
      if (!connectionId) return;
      const next = savedStamp(connectionId);
      if (next !== stamp) {
        stamp = next;
        end();
      }
    });
    return () => {
      stopLock();
      stopVault();
      stopRows();
      clear();
    };
  }, [clear, connectionId, onWithdraw]);
  async function runAi(
    work: (
      owner: SecretBackendActionOwner,
      signal: AbortSignal,
    ) => Promise<string | undefined>,
  ) {
    return action.run(async (owner) => {
      const controller = new AbortController();
      prediction.current = controller;
      try {
        return await work(owner, controller.signal);
      } catch (error) {
        if (
          error instanceof ReplicatePredictionInterrupted &&
          error.cancellationRequested
        ) {
          owner.check();
          return error.message;
        }
        throw error;
      } finally {
        if (prediction.current === controller) prediction.current = null;
      }
    });
  }
  return { ...action, runAi, onCancel: () => prediction.current?.abort() };
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
  const [predictionInput, setPredictionInput] = useState("");
  const audio = useLocalAudioInput();
  const clearAudio = audio.clear;
  const withdraw = useCallback(() => {
    setDraft((current) => ({ ...current, apiKey: "" }));
    setPredictionInput("");
    clearAudio();
  }, [clearAudio]);
  const pending = useAiOperation(onFlash, withdraw);
  function onChange<Key extends keyof AiConnectionDraft>(
    field: Key,
    value: AiConnectionDraft[Key],
  ) {
    pending.clear();
    clearAudio();
    setDraft((current) => changeDraft(current, field, value));
    if (["family", "baseUrl", "model", "authentication"].includes(field))
      setPredictionInput("");
  }
  async function run(save: boolean) {
    await pending.runAi(async (owner, signal) => {
      const input =
        draft.family === "replicate_predictions"
          ? replicateVerificationInput(draft, predictionInput)
          : undefined;
      const options = {
        signal: owner.signal,
        prediction: { signal },
        audio:
          draft.family === "elevenlabs_scribe"
            ? audio.fields.sampleAudio
            : undefined,
      };
      try {
        if (!save)
          return await aiConnectionUiDependencies.test(
            draft,
            savedId,
            input,
            options,
          );
        const view = await aiConnectionUiDependencies.save(
          draft,
          savedId,
          input,
          options,
        );
        owner.check();
        setSavedId(view.connectionId);
        withdraw();
        window.dispatchEvent(new Event("opensesame:ai-connections-changed"));
        onSaved?.();
        return "AI connection verified and saved in this vault";
      } catch (error) {
        if (error instanceof ReplicatePredictionInterrupted) throw error;
        const text =
          error instanceof Error ? error.message : "The AI operation failed.";
        throw new Error(
          draft.apiKey ? text.replaceAll(draft.apiKey, "[credential]") : text,
        );
      }
    });
  }
  return {
    ...pending,
    draft,
    ...aiAudioControls(audio, pending, draft.family === "elevenlabs_scribe"),
    savedId,
    predictionInput,
    onPredictionInput: (value: string) => {
      pending.clear();
      setPredictionInput(value);
    },
    hasSavedCredentials: Boolean(savedId && readAiConnection(savedId)),
    canRetainCredential: canRetainCredential(draft, savedId),
    onChange,
    onSave: () => void run(true),
    onTest: () => void run(false),
    onForget: () =>
      void forgetAiConnection(
        savedId,
        pending,
        () => {
          setSavedId(undefined);
          withdraw();
        },
        onSaved,
      ),
  };
}

async function forgetAiConnection(
  id: string | undefined,
  pending: Pick<ReturnType<typeof useAiOperation>, "runAi">,
  onForgot: () => void,
  onSaved?: () => void,
) {
  if (!id) return;
  await pending.runAi(async (owner) => {
    await aiConnectionUiDependencies.remove(id);
    owner.check();
    onForgot();
    window.dispatchEvent(new Event("opensesame:ai-connections-changed"));
    onSaved?.();
    return "AI connection forgotten";
  });
}

function aiAudioControls(
  audio: ReturnType<typeof useLocalAudioInput>,
  pending: Pick<ReturnType<typeof useAiOperation>, "clear" | "onCancel">,
  speech: boolean,
) {
  return {
    ...audio.fields,
    onSampleAudio: (file: File | undefined) => {
      pending.clear();
      audio.fields.onSampleAudio(file);
    },
    onCancel: () => {
      if (speech) {
        pending.clear();
        audio.clear();
      } else pending.onCancel();
    },
  };
}
