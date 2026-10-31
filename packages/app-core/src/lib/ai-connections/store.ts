import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type StringFields,
  readDeviceRows,
} from "../device-connector-records.js";
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
  AzureOpenAiTargetSchema,
  azureConnectionTarget,
} from "./azure-protocol.js";
import { BedrockAiTargetSchema } from "./bedrock-target.js";
import {
  aiConnectionBinding,
  aiCredentialDigest,
  validateAiConnection,
} from "./configuration.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";
import {
  VertexAiTargetSchema,
  vertexConnectionTarget,
} from "./vertex-target.js";

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
    "azure_target",
    "vertex_target",
    "bedrock_target",
  ],
  privateCredentials: ["ai_credential_reference", "ai_credential_digest"],
};

export function aiConnectionRecord(id: string): NativeConnectorRecord | null {
  const record = loadNativeConnectorRecord(id);
  return record?.configuration.parameters.ai_contract === AI_CONNECTION_CONTRACT
    ? record
    : null;
}

function readAzureTarget(value: string | undefined) {
  if (value === undefined) return {};
  try {
    if (!value || value.length > 512) throw new Error("Invalid target size");
    const target = AzureOpenAiTargetSchema.safeParse(JSON.parse(value));
    if (!target.success) throw new Error("Invalid target metadata");
    return { azure: target.data };
  } catch {
    throw new AiConnectionError(
      "configuration",
      "The saved Azure target is invalid. Configure and verify this connection again.",
    );
  }
}

function readVertexTarget(value: string | undefined) {
  if (value === undefined) return {};
  try {
    if (!value || value.length > 512) throw new Error("Invalid target size");
    const target = VertexAiTargetSchema.safeParse(JSON.parse(value));
    if (!target.success) throw new Error("Invalid target metadata");
    return { vertex: target.data };
  } catch {
    throw new AiConnectionError(
      "configuration",
      "The saved Vertex target is invalid. Configure and verify this connection again.",
    );
  }
}

function readBedrockTarget(value: string | undefined) {
  if (value === undefined) return {};
  try {
    if (!value || value.length > 512) throw new Error("Invalid target size");
    const target = BedrockAiTargetSchema.safeParse(JSON.parse(value));
    if (!target.success) throw new Error("Invalid target metadata");
    return { bedrock: target.data };
  } catch {
    throw new AiConnectionError(
      "configuration",
      "The saved Bedrock target is invalid. Configure and verify this connection again.",
    );
  }
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
      ...readAzureTarget(parameters.azure_target),
      ...readVertexTarget(parameters.vertex_target),
      ...readBedrockTarget(parameters.bedrock_target),
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
  const target = azureConnectionTarget(draft);
  const azure = target
    ? JSON.stringify(
        target.api === "v1"
          ? { api: target.api, credential: target.credential }
          : {
              api: target.api,
              apiVersion: target.apiVersion,
              credential: target.credential,
            },
      )
    : undefined;
  const fingerprint = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([aiConnectionBinding(draft), tomb]),
      ),
    ),
  );
  const targetId = `ai-${fingerprint}`;
  const parameters: StringFields = {
    ai_contract: AI_CONNECTION_CONTRACT,
    family: draft.family,
    base_url: draft.baseUrl,
    model: draft.model,
    authentication: draft.authentication,
    vault_tomb: tomb,
    token_parameter: draft.tokenParameter,
  };
  if (azure !== undefined) parameters.azure_target = azure;
  const vertex = vertexConnectionTarget(draft);
  if (vertex)
    parameters.vertex_target = JSON.stringify({
      project: vertex.project,
      location: vertex.location,
      credential: vertex.credential,
    });
  if (draft.bedrock)
    parameters.bedrock_target = JSON.stringify({
      region: draft.bedrock.region,
      credential: draft.bedrock.credential,
    });
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
      parameters,
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
