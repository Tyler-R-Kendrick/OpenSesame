/** A shared AI proof describes its configured endpoint, never a vendor's dated probe. */
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
} from "../native-connector-store.js";
import { requireNativeKey } from "../native-key-state.js";
import {
  type VaultCredentialRead,
  assertVaultCredentials,
  readVaultCredentials,
} from "../vault-credential-custody.js";
import {
  aiConnectionBinding,
  aiCredentialDigest,
  validateAiConnection,
} from "./configuration.js";
import { isAiConnectionProvider } from "./presets.js";
import { isAiSpeechProvider } from "./speech-target.js";
import {
  AI_CONNECTION_CLASSIFICATION,
  AI_CONNECTION_CONTRACT,
  readAiConnection,
} from "./store.js";
import { aiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";

export type AiConnectionProjection = "ordinary" | "pending" | "verified";
const EMPTY_CAPTURE = { items: [] };
const KEY_SPEC = {
  family: "AI",
  accepts: (providerId: string) =>
    isAiConnectionProvider(providerId) || isAiSpeechProvider(providerId),
  classification: AI_CONNECTION_CLASSIFICATION,
};
function captureCredentials(
  record: NativeConnectorRecord,
  draft: AiConnectionDraft,
  tomb: string,
): Pick<VaultCredentialRead, "items"> {
  if (draft.authentication !== "api-key") return EMPTY_CAPTURE;
  const reference = record.privateState.credentials.ai_credential_reference;
  if (!reference) throw new Error("The AI vault credential is missing.");
  const held = readVaultCredentials(
    decodeURIComponent(reference),
    aiConnectionBinding(draft),
    ["apiKey"],
    tomb,
  );
  draft.apiKey = held.fields.get("apiKey") ?? "";
  if (
    aiCredentialDigest(draft.apiKey) !==
    record.privateState.credentials.ai_credential_digest
  )
    throw new Error("The AI vault credential changed.");
  return held;
}

/** Synchronous, read-only and secret-free; actual inference remains the proof producer. */
export function aiConnectionProjection(id: string): AiConnectionProjection {
  try {
    const saved = loadNativeConnectorRecord(id);
    if (saved?.configuration.parameters.ai_contract === undefined)
      return "ordinary";
    if (saved.configuration.parameters.ai_contract !== AI_CONNECTION_CONTRACT)
      return "pending";
    const record = requireNativeKey(KEY_SPEC, id, true);
    const draft = readAiConnection(id);
    const tomb = record.configuration.parameters.vault_tomb;
    if (!draft || !tomb) return "pending";
    const fingerprint = aiCredentialDigest(
      JSON.stringify([aiConnectionBinding(draft), tomb]),
    );
    if (
      fingerprint !== record.configuration.fingerprint ||
      record.configuration.targetIds.endpoint !== `ai-${fingerprint}` ||
      record.privateState.grants.app?.targetId !== `ai-${fingerprint}`
    )
      return "pending";
    const transport = aiConnectionTransport();
    let capture: Pick<VaultCredentialRead, "items"> = EMPTY_CAPTURE;
    const admit = transport.assertEndpointAllowed;
    if (!admit) return "pending";
    const sameTransport = () => {
      if (aiConnectionTransport() !== transport)
        throw new Error("The current AI connection authority changed.");
    };
    const check = () => {
      sameTransport();
      transport.signal.throwIfAborted();
      transport.assertCurrent();
      admit(draft.baseUrl);
      sameTransport();
      assertVaultCredentials(capture, tomb, () => {
        transport.signal.throwIfAborted();
        transport.assertCurrent();
      });
      sameTransport();
    };
    check();
    capture = captureCredentials(record, draft, tomb);
    validateAiConnection(draft);
    check();
    const current = requireNativeKey(KEY_SPEC, id, true);
    return current.revision === record.revision &&
      current.configuration.fingerprint === fingerprint
      ? "verified"
      : "pending";
  } catch {
    return "pending";
  }
}
