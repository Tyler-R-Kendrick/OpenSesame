import type { NativeConnectorRecord } from "../native-connector-store.js";
import {
  initializeVaultCredentialCustody,
  readVaultCredentials,
} from "../vault-credential-custody.js";
import {
  aiConnectionBinding,
  aiCredentialDigest,
  validateAiConnection,
} from "./configuration.js";
import { readAiConnection } from "./store.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

/** Only the owning unlocked vault can resolve a saved token reference. */
export async function resolvedAiConnection(
  record: NativeConnectorRecord,
  tomb: string,
): Promise<AiConnectionDraft> {
  if (record.configuration.parameters.vault_tomb !== tomb)
    throw new AiConnectionError(
      "authentication",
      "Unlock the vault that saved this AI connection.",
    );
  const draft = readAiConnection(record.connectionId);
  if (!draft)
    throw new AiConnectionError("configuration", "AI connection not found.");
  if (draft.authentication === "api-key") {
    await initializeVaultCredentialCustody();
    const reference = record.privateState.credentials.ai_credential_reference;
    if (!reference)
      throw new AiConnectionError(
        "authentication",
        "Save this connection's API key in the owning vault.",
      );
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
      throw new AiConnectionError(
        "authentication",
        "The saved AI credential changed. Verify and save its replacement before use.",
      );
  }
  return validateAiConnection(draft);
}

export async function capturedAiCredentials(
  record: NativeConnectorRecord,
  tomb: string,
) {
  const draft = readAiConnection(record.connectionId);
  if (!draft || record.configuration.parameters.vault_tomb !== tomb)
    throw new AiConnectionError(
      "authentication",
      "Unlock the owning AI connection vault.",
    );
  const encoded = record.privateState.credentials.ai_credential_reference;
  if (!encoded) return { reference: "", items: [] };
  await initializeVaultCredentialCustody();
  const reference = decodeURIComponent(encoded);
  return {
    reference,
    items: readVaultCredentials(
      reference,
      aiConnectionBinding(draft),
      ["apiKey"],
      tomb,
    ).items,
  };
}
