import {
  acknowledgeCertificateDelivery,
  issueCertificate,
} from "@opensesame/app-core/lib/certs.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import {
  acceptsDraftUsername,
  isGeneratedDraftName,
  newItemDraft,
} from "@opensesame/app-core/lib/vault/new-draft.js";
import { validateWebsitePatterns } from "@opensesame/app-core/lib/vault/website-pattern.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  type AccountItem,
  type Folder,
  type VaultItem,
  definitionFor,
  itemTypeId,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import { type FieldValue, missingRequired } from "@opensesame/vault-item-types";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useWebMcpLoginDraft } from "../../bindings/webmcp-login-draft.js";
import { EmptyTip } from "../../components/EmptyTip.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff } from "../../components/Icons.js";
import { useVaultAllTo } from "../../lib/vault-list-path.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { AccountFields } from "./AccountFields.js";
import { CredentialFields } from "./CredentialFields.js";
import { EditorActions } from "./EditorActions.js";
import { EditorExtras } from "./EditorExtras.js";
import { EditorTitle } from "./EditorTitle.js";
import { UnknownItemType } from "./EditorType.js";
import { NativeItemFields } from "./NativeItemFields.js";
import { TypedFieldInputs } from "./TypedFields.js";
import {
  saveWithCredentials,
  settleForSave,
  settleMethods,
} from "./account-secrets.js";
import { useEditorContributions } from "./item-contributions.js";
import { seedDraft } from "./seed-draft.js";
import { useEditorPath } from "./useEditorPath.js";

export function ItemEditor({ mode }: { mode: "new" | "edit" }) {
  const { kind, itemId } = useParams();
  if (mode === "new" && kind !== undefined && !itemTypeRegistry().has(kind)) {
    return <UnknownItemType />;
  }
  return (
    <EditorForm key={`${mode}:${kind ?? ""}:${itemId ?? ""}`} mode={mode} />
  );
}

function EditorForm({ mode }: { mode: "new" | "edit" }) {
  const { kind: kindParam, itemId } = useParams();
  const [search] = useSearchParams();
  const allItemsTo = useVaultAllTo();
  const navigate = useNavigate();
  const { items, folders } = useVault();
  const store = useVaultStore();
  const existing = items.find((candidate) => candidate.id === itemId);
  const liveAccounts = useMemo(
    () =>
      items.filter(
        (item): item is AccountItem =>
          item.kind === "account" && item.deletedAt === null,
      ),
    [items],
  );
  const initial = useMemo(
    () => seedDraft(mode, existing, kindParam, search),
    [mode, existing, kindParam, search],
  );

  const [draft, setDraft] = useState<VaultItem | null>(initial.item);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initial.error);
  const [pendingDeliveryId, setPendingDeliveryId] = useState<string>();
  const [issuanceKey, setIssuanceKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    setDraft(initial.item);
    setError(initial.error);
    setReveal(false);
    setPendingDeliveryId(undefined);
    setIssuanceKey(crypto.randomUUID());
  }, [initial]);

  const patch = (changes: Partial<VaultItem>) =>
    setDraft((current) =>
      current ? overlapCast({ ...current, ...changes }) : current,
    );
  const path = useEditorPath(
    draft ?? { name: "", folderId: null },
    folders,
    patch,
    setError,
  );
  useWebMcpLoginDraft(draft, folders, patch);
  const { Create, Suggestions } = useEditorContributions(draft?.kind);

  if (!draft) {
    return (
      <div className="detail">
        <div className="empty">
          <h2>Nothing to edit</h2>
          <EmptyTip tip="escBack" />
          <Link className="btn btn--sm" to="/vault">
            Back to the vault
          </Link>
        </div>
      </div>
    );
  }

  const selectedFolder = path.choices.find(
    (entry) => entry.id === draft.folderId,
  );
  const changeType = (
    typeId: string,
    name?: string,
    folder: Folder | null = selectedFolder ?? null,
  ) => {
    path.stage(folder ?? undefined);
    // A name the previous type generated belongs to that type, so it is
    // replaced with this type's own; a name the person typed is theirs and
    // travels with the draft.
    const carried =
      name ??
      (isGeneratedDraftName(draft.name, itemTypeId(draft))
        ? undefined
        : draft.name);
    setDraft({
      ...newItemDraft(typeId, carried),
      folderId: folder?.id ?? null,
      notes: draft.notes,
    });
    setError(null);
    setReveal(false);
  };
  const onTypeChange =
    mode === "new" && kindParam === undefined ? changeType : undefined;

  // A drop is a one-time share, not an editable item.
  if (draft.kind === "drop") {
    if (mode === "new" && Create)
      return (
        <Create
          initialName={draft.name}
          initialFolder={selectedFolder}
          onTypeChange={onTypeChange}
        />
      );
    return (
      <div className="detail">
        <div className="empty">
          <h2>Drops cannot be edited</h2>
          <EmptyTip tip="escBack" />
          <Link className="btn btn--sm" to={`/vault/${draft.id}`}>
            Back to the drop
          </Link>
        </div>
      </div>
    );
  }

  const draftTypeId = itemTypeId(draft);
  const typedDefinition =
    draft.kind === "typed" ? definitionFor(draft) : undefined;

  const patchValue = (fieldId: string, value: FieldValue) =>
    setDraft((current) =>
      current === null || current.kind !== "typed"
        ? current
        : { ...current, values: { ...current.values, [fieldId]: value } },
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() && draft.kind !== "certificate") {
      setError("Give this item a name so you can find it again.");
      return;
    }
    if (
      draft.kind === "certificate" &&
      !draft.certificatePem &&
      !draft.commonName.trim()
    ) {
      setError("Enter the certificate's common name before issuing it.");
      return;
    }
    // The editor marks a required field with a star. Saying so and then
    // saving anyway is worse than not marking it at all.
    if (draft.kind === "typed" && typedDefinition !== undefined) {
      const missing = missingRequired(typedDefinition, draft.values);
      if (missing.length > 0) {
        setError(
          `Fill in ${missing.map((field) => field.label).join(", ")} before saving.`,
        );
        return;
      }
    }
    setSaving(true);
    setError(null);
    let deliveryId = pendingDeliveryId;
    try {
      const location = path.resolve();
      if (draft.kind === "account") await validateWebsitePatterns(draft.uris);
      let next = { ...draft, name: location.name, folderId: location.folderId };
      if (next.kind === "certificate" && !next.certificatePem) {
        const issued = await issueCertificate({
          commonName: next.commonName.trim(),
          dnsNames: next.dnsNames
            .split(/[,\s]+/)
            .map((name) => name.trim())
            .filter(Boolean),
          ipAddrs: next.ipAddrs
            .split(/[,\s]+/)
            .map((name) => name.trim())
            .filter(Boolean),
          ttlHours: Number(next.ttlHours) || 24,
          idempotencyKey: issuanceKey,
        });
        deliveryId = issued.deliveryId;
        setPendingDeliveryId(deliveryId);
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
        // Keep one-time material in memory if vault sealing fails. A retry
        // saves this exact issuance instead of minting another certificate.
        setDraft(next);
      }
      if (next.kind === "account") {
        // `changedAt` moves with the password it describes (ADR 0174).
        next = settleForSave(
          next,
          existing?.kind === "account" ? existing : undefined,
        );
      }
      if (next.kind === "credential") {
        const [method = next.method] = settleMethods(
          [next.method],
          existing?.kind === "credential" ? [existing.method] : [],
        );
        next = { ...next, method };
      }
      await saveWithCredentials(store, items, next, location.folder);
      if (deliveryId) {
        await acknowledgeCertificateDelivery(deliveryId);
        setPendingDeliveryId(undefined);
      }
      navigate(`/vault/${next.id}`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save this item.",
      );
    } finally {
      setSaving(false);
    }
  }

  const closeTo = mode === "edit" ? `/vault/${draft.id}` : allItemsTo;
  const saveVerb = saving
    ? draft.kind === "certificate" && !draft.certificatePem
      ? "Issuing…"
      : "Sealing…"
    : draft.kind === "certificate" && !draft.certificatePem
      ? mode === "new"
        ? "Create certificate"
        : "Issue now"
      : "Save item";

  return (
    <div className="detail">
      <form className="editor" onSubmit={(event) => void onSubmit(event)}>
        <EditorTitle
          value={draft}
          folders={path.choices}
          onName={path.typed}
          onFolder={(folder) => path.select(folder ?? undefined)}
          onBlur={path.blur}
          typeId={draftTypeId}
          onTypeChange={onTypeChange}
          focusName
          onPin={(favorite) => patch({ favorite })}
        />
        {mode === "new" && Suggestions ? (
          <Suggestions
            key={`${draftTypeId}:${draft.kind === "account" ? draft.uris[0]?.uri : ""}`}
            typeId={draftTypeId}
            website={draft.kind === "account" ? draft.uris[0]?.uri : undefined}
            onApply={(labels) => {
              patch({ name: labels.name });
              if (draft.kind === "account" || draft.kind === "passkey")
                patch({ username: labels.username });
              if (draft.kind === "typed" && acceptsDraftUsername(draftTypeId))
                patchValue("username", labels.username);
            }}
          />
        ) : null}
        {draft.kind === "account" ? (
          <AccountFields
            draft={draft}
            liveRoll={mode === "new"}
            onPatch={patch}
          />
        ) : null}

        {draft.kind === "credential" ? (
          <CredentialFields
            draft={draft}
            accounts={liveAccounts}
            liveRoll={mode === "new"}
            onPatch={patch}
          />
        ) : null}

        {draft.kind === "secret" ? (
          <div className="editor__grid">
            <div className="field">
              <label htmlFor="secret-value">Secret value</label>
              <div className="editor__inline editor__inline--adorned">
                <input
                  id="secret-value"
                  type={reveal ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={FIELD_LIMITS.secret}
                  value={draft.value}
                  onChange={(event) => patch({ value: event.target.value })}
                />
                <IconKey
                  label={reveal ? "Hide secret" : "Show secret"}
                  onClick={() => setReveal((value) => !value)}
                >
                  {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
                </IconKey>
              </div>
            </div>
          </div>
        ) : null}

        <NativeItemFields
          key={`native:${draft.id}`}
          draft={draft}
          onChange={patch}
        />

        {typedDefinition !== undefined && draft.kind === "typed" ? (
          <TypedFieldInputs
            definition={typedDefinition}
            values={draft.values}
            onChange={patchValue}
          />
        ) : null}

        {draft.kind === "typed" && typedDefinition === undefined ? (
          <p className="hint">Definition not installed.</p>
        ) : null}

        <EditorExtras key={draft.id} draft={draft} onChange={patch} />

        <FailureNotice
          id={`vault:item-editor:${draft.id}`}
          title="Item"
          message={error}
        />
        <EditorActions busy={saving} label={saveVerb} closeTo={closeTo} />
      </form>
    </div>
  );
}
