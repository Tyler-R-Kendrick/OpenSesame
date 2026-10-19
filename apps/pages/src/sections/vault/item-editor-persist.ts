/**
 * The editor's save, shared by the submit key and a reload that has to land
 * before the person finishes. A draft that fails validation is not written.
 */

import {
  acknowledgeCertificateDelivery,
  issueCertificate,
} from "@opensesame/app-core/lib/certs.js";
import { validateWebsitePatterns } from "@opensesame/app-core/lib/vault/website-pattern.js";
import {
  type Folder,
  type VaultItem,
  definitionFor,
} from "@opensesame/vault-core";
import { missingRequired } from "@opensesame/vault-item-types";
import {
  type ItemWriter,
  saveWithCredentials,
  settleForSave,
  settleMethods,
} from "./account-secrets.js";

export type EditorPersistResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

type Located = {
  name: string;
  folderId: string | null;
  folder?: Folder;
};

export type EditorPersistInput = {
  draft: VaultItem;
  existing: VaultItem | undefined;
  items: readonly VaultItem[];
  writer: ItemWriter;
  locate: () => Located;
  pendingDeliveryId: string | undefined;
  issuanceKey: string;
  rememberIssued: (next: VaultItem, deliveryId: string | undefined) => void;
  clearDelivery: () => void;
};

/** What the editor says before it tries to seal. Null when the draft can be saved. */
export function editorDraftError(draft: VaultItem): string | null {
  if (!draft.name.trim() && draft.kind !== "certificate") {
    return "Give this item a name so you can find it again.";
  }
  if (
    draft.kind === "certificate" &&
    !draft.certificatePem &&
    !draft.commonName.trim()
  ) {
    return "Enter the certificate's common name before issuing it.";
  }
  if (draft.kind === "typed") {
    const definition = definitionFor(draft);
    if (definition !== undefined) {
      const missing = missingRequired(definition, draft.values);
      if (missing.length > 0) {
        return `Fill in ${missing.map((field) => field.label).join(", ")} before saving.`;
      }
    }
  }
  return null;
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

type PreparedEditorDraft = {
  next: VaultItem;
  deliveryId: string | undefined;
};

/**
 * Validate, issue, and settle before the vault write. A certificate that
 * fails to seal stays in memory so the retry does not mint another one.
 */
async function prepareEditorDraft(
  located: VaultItem,
  input: EditorPersistInput,
): Promise<PreparedEditorDraft> {
  let next = located;
  let deliveryId = input.pendingDeliveryId;
  if (next.kind === "account") await validateWebsitePatterns(next.uris);
  if (next.kind === "certificate" && !next.certificatePem) {
    const issued = await issueCertificate({
      commonName: next.commonName.trim(),
      dnsNames: splitList(next.dnsNames),
      ipAddrs: splitList(next.ipAddrs),
      ttlHours: Number(next.ttlHours) || 24,
      idempotencyKey: input.issuanceKey,
    });
    deliveryId = issued.deliveryId;
    next = {
      ...next,
      name: next.name.trim() || issued.commonName,
      commonName: issued.commonName,
      dnsNames: issued.dnsNames.join(", "),
      certificatePem: issued.certificate,
      privateKeyPem: issued.privateKey,
      caPem: issued.caCertificate,
      serial: issued.serial,
      notAfter: issued.notAfter,
    };
    input.rememberIssued(next, deliveryId);
  }
  if (next.kind === "account") {
    next = settleForSave(
      next,
      input.existing?.kind === "account" ? input.existing : undefined,
    );
  }
  if (next.kind === "credential") {
    const [method = next.method] = settleMethods(
      [next.method],
      input.existing?.kind === "credential" ? [input.existing.method] : [],
    );
    next = { ...next, method };
  }
  return { next, deliveryId };
}

/** Seal `draft`. The caller navigates; this only writes. */
export async function persistEditorDraft(
  input: EditorPersistInput,
): Promise<EditorPersistResult> {
  const rejected = editorDraftError(input.draft);
  if (rejected) return { ok: false, message: rejected };
  try {
    const location = input.locate();
    const prepared = await prepareEditorDraft(
      { ...input.draft, name: location.name, folderId: location.folderId },
      input,
    );
    await saveWithCredentials(
      input.writer,
      input.items,
      prepared.next,
      location.folder,
    );
    if (prepared.deliveryId) {
      await acknowledgeCertificateDelivery(prepared.deliveryId);
      input.clearDelivery();
    }
    return { ok: true, id: prepared.next.id };
  } catch (caught) {
    return {
      ok: false,
      message:
        caught instanceof Error ? caught.message : "Could not save this item.",
    };
  }
}
