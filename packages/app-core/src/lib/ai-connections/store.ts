import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { readDeviceRows } from "../device-connector-records.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "../native-connector-store.js";
import { verifiedNativeKey } from "../native-key-state.js";
import { nativeOAuthGuard } from "../native-oauth-session.js";
import {
  aiConnectionBinding,
  aiCredentialDigest,
  validateAiConnection,
} from "./configuration.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

export const AI_CONNECTION_CONTRACT = "ai-connection-v1";
export const AI_CONNECTION_CLASSIFICATION = {
  publicParameters: [
    "ai_contract",
    "family",
    "base_url",
    "model",
    "authentication",
    "vault_tomb",
    "token_parameter",
  ],
  privateCredentials: ["ai_credential_reference", "ai_credential_digest"],
};

export function aiConnectionRecord(id: string): NativeConnectorRecord | null {
  const record = loadNativeConnectorRecord(id);
  return record?.configuration.parameters.ai_contract === AI_CONNECTION_CONTRACT
    ? record
    : null;
}

export function readAiConnection(id: string): AiConnectionDraft | null {
  const record = aiConnectionRecord(id);
  if (!record) return null;
  const { providerId, displayName, parameters } = record.configuration;
  return validateAiConnection(
    {
      providerId,
      name: displayName,
      family: parameters.family,
      baseUrl: parameters.base_url,
      model: parameters.model,
      authentication: parameters.authentication,
      tokenParameter: parameters.token_parameter,
      apiKey: "",
    },
    false,
  );
}

export function savedAiConnections() {
  return readDeviceRows().flatMap((row) => {
    const draft = readAiConnection(row.connectionId);
    const view = draft ? readNativeConnector(row.connectionId) : null;
    return draft && view ? [{ draft, view }] : [];
  });
}

function connectionRecord(
  draft: AiConnectionDraft,
  tomb: string,
  reference: string,
  id: string,
  revision: number,
) {
  const fingerprint = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([aiConnectionBinding(draft), tomb]),
      ),
    ),
  );
  const targetId = `ai-${fingerprint}`;
  return verifiedNativeKey(
    AI_CONNECTION_CLASSIFICATION,
    id,
    revision,
    {
      version: 1,
      providerId: draft.providerId,
      method: "api-key",
      displayName: draft.name,
      icon: "",
      parameters: {
        ai_contract: AI_CONNECTION_CONTRACT,
        family: draft.family,
        base_url: draft.baseUrl,
        model: draft.model,
        authentication: draft.authentication,
        vault_tomb: tomb,
        token_parameter: draft.tokenParameter,
      },
      requestedScopes: {},
      targetIds: { endpoint: targetId },
      fingerprint,
    },
    reference
      ? {
          ai_credential_reference: encodeURIComponent(reference),
          ai_credential_digest: aiCredentialDigest(draft.apiKey),
        }
      : {},
    {
      identity: { id: targetId, label: draft.name, kind: "model-endpoint" },
      targets: [{ id: targetId, label: draft.baseUrl, kind: "model-endpoint" }],
      grantLabel: "Configured AI inference",
      target: { key: "endpoint", id: targetId },
    },
  );
}

export async function commitAiConnection(
  draft: AiConnectionDraft,
  tomb: string,
  reference: string,
  check: () => void,
  previous?: NativeConnectorRecord,
) {
  const id = previous?.connectionId ?? `native-ai-${crypto.randomUUID()}`;
  const record = connectionRecord(
    draft,
    tomb,
    reference,
    id,
    previous?.revision ?? 1,
  );
  if (!previous)
    return saveNativeConnector(record, AI_CONNECTION_CLASSIFICATION, check);
  if (previous.configuration.providerId !== draft.providerId)
    throw new AiConnectionError(
      "configuration",
      "This connection belongs to a different provider.",
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(previous),
    AI_CONNECTION_CLASSIFICATION,
    () => {
      check();
      return record;
    },
    check,
  );
}
