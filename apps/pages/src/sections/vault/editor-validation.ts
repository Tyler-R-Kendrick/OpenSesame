import type { VaultItem, definitionFor } from "@opensesame/vault-core";
import { missingRequired } from "@opensesame/vault-item-types";

/** Existing draft validation, before any asynchronous operation begins. */
export function editorDraftError(
  draft: VaultItem,
  definition: ReturnType<typeof definitionFor>,
): string | null {
  if (!draft.name.trim() && draft.kind !== "certificate")
    return "Give this item a name so you can find it again.";
  if (
    draft.kind === "certificate" &&
    !draft.certificatePem &&
    !draft.commonName.trim()
  )
    return "Enter the certificate's common name before issuing it.";
  if (draft.kind === "typed" && definition !== undefined) {
    const missing = missingRequired(definition, draft.values);
    if (missing.length > 0)
      return `Fill in ${missing.map((field) => field.label).join(", ")} before saving.`;
  }
  return null;
}
