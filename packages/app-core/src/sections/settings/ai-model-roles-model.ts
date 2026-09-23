/**
 * View-model logic for `AiModelRoles` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { ModelProviderRecord } from "../../lib/model-provider.js";

export function emptyAiRecord(): ModelProviderRecord {
  return {
    kind: "none",
    provider: "",
    endpoint: "",
    model: "",
    voice: {
      provider: "browser-speech",
      kind: "browser",
      endpoint: "",
      model: "en-US",
    },
    inference: {
      provider: "",
      kind: "none",
      endpoint: "",
      model: "",
    },
  };
}
