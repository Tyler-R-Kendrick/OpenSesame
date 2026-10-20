import { registerDraftSaver } from "@opensesame/app-core/lib/dirty-edit.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import {
  acceptsDraftUsername,
  isGeneratedDraftName,
  newItemDraft,
} from "@opensesame/app-core/lib/vault/new-draft.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  type AccountItem,
  type Folder,
  type VaultItem,
  definitionFor,
  itemTypeId,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import type { FieldValue } from "@opensesame/vault-item-types";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { useEditorContributions } from "./item-contributions.js";
import {
  type EditorPersistResult,
  editorDraftError,
  persistEditorDraft,
} from "./item-editor-persist.js";
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

/** The latest value, including renders that returned before a saver ran. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
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

  const draftRef = useLatest(draft);
  const formRef = useRef<HTMLFormElement>(null);
  const persistRef = useRef<() => Promise<EditorPersistResult>>(async () => ({
    ok: false,
    message: "Nothing to edit",
  }));
  useEffect(
    () =>
      registerDraftSaver("vault-item-editor", async () => {
        const result = await persistRef.current();
        if (!result.ok) return false;
        formRef.current?.dispatchEvent(
          new Event("os-edit-committed", { bubbles: true }),
        );
        return true;
      }),
    [],
  );

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

  persistRef.current = () => {
    const current = draftRef.current;
    if (!current || current.kind === "drop") {
      return Promise.resolve({ ok: false, message: "Nothing to edit" });
    }
    return persistEditorDraft({
      draft: current,
      existing,
      items,
      writer: store,
      locate: () => {
        const location = path.resolve();
        return {
          name: location.name,
          folderId: location.folderId,
          folder: location.folder,
        };
      },
      pendingDeliveryId,
      issuanceKey,
      rememberIssued: (next, deliveryId) => {
        setPendingDeliveryId(deliveryId);
        setDraft(next);
      },
      clearDelivery: () => setPendingDeliveryId(undefined),
    });
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const current = draftRef.current;
    if (!current) return;
    const rejected = editorDraftError(current);
    if (rejected) {
      setError(rejected);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await persistRef.current();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      formRef.current?.dispatchEvent(
        new Event("os-edit-committed", { bubbles: true }),
      );
      navigate(`/vault/${result.id}`);
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
      <form
        ref={formRef}
        className="editor"
        onSubmit={(event) => void onSubmit(event)}
      >
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
            itemName={draft.name}
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
