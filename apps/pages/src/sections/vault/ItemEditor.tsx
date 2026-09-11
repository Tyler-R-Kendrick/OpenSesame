import { overlapCast } from "@opensesame/os-domain";
import { type FieldValue, missingRequired } from "@opensesame/vault-item-types";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  IconEye,
  IconEyeOff,
  IconRefresh,
  IconX,
} from "../../components/Icons.js";
import { PasswordGenerator } from "../../components/PasswordGenerator.js";
import {
  acknowledgeCertificateDelivery,
  issueCertificate,
} from "../../lib/certs.js";
import { compileSecretToHost } from "../../lib/connections.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  definitionFor,
  itemTypeId,
  itemTypeRegistry,
} from "../../lib/vault/item-types.js";
import {
  type Folder,
  type VaultItem,
  newGrant,
} from "../../lib/vault/model.js";
import {
  acceptsDraftUsername,
  newItemDraft,
  prefillNewDraft,
} from "../../lib/vault/new-draft.js";
import { validateWebsitePatterns } from "../../lib/vault/website-pattern.js";
import { DraftSuggestions } from "./DraftSuggestions.js";
import { EditorActions } from "./EditorActions.js";
import { EditorExtras, GroupAdd, OptionalField } from "./EditorExtras.js";
import { EditorTitle } from "./EditorTitle.js";
import { UnknownItemType } from "./EditorType.js";
import { LoginWebsites } from "./LoginWebsites.js";
import { NativeItemFields } from "./NativeItemFields.js";
import { NewDropCeremony } from "./NewDropCeremony.js";
import { TypedFieldInputs } from "./TypedFields.js";
import { useWebMcpLoginDraft } from "../../webmcp/login-draft.js";
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
  const navigate = useNavigate();
  const { items, folders } = useVault();
  const store = useVaultStore();
  const existing = items.find((candidate) => candidate.id === itemId);
  const initial = useMemo(() => {
    if (mode === "edit") return { item: existing ?? null, error: null };
    try {
      return {
        item: prefillNewDraft(kindParam ?? "login", search),
        error: null,
      };
    } catch {
      return {
        item: newItemDraft(kindParam ?? "login"),
        error:
          "Link values were refused. Use public metadata parameters or supported field.<id> values; never put secrets in links.",
      };
    }
  }, [mode, existing, kindParam, search]);

  const [draft, setDraft] = useState<VaultItem | null>(initial.item);
  const [showGenerator, setShowGenerator] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initial.error);
  const [pendingDeliveryId, setPendingDeliveryId] = useState<string>();
  const [issuanceKey, setIssuanceKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    setDraft(initial.item);
    setError(initial.error);
    setShowGenerator(false);
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

  if (!draft) {
    return (
      <div className="detail">
        <div className="empty">
          <h2>Nothing to edit</h2>
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
    name = draft.name,
    folder: Folder | null = selectedFolder ?? null,
  ) => {
    path.stage(folder ?? undefined);
    setDraft({
      ...newItemDraft(typeId, name),
      folderId: folder?.id ?? null,
      notes: draft.notes,
    });
    setError(null);
    setShowGenerator(false);
    setReveal(false);
  };
  const onTypeChange =
    mode === "new" && kindParam === undefined ? changeType : undefined;

  // A drop is a one-time share, not an editable item.
  if (draft.kind === "drop") {
    if (mode === "new")
      return (
        <NewDropCeremony
          initialName={draft.name}
          initialFolder={selectedFolder}
          onTypeChange={onTypeChange}
        />
      );
    return (
      <div className="detail">
        <div className="empty">
          <h2>Drops cannot be edited</h2>
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
      if (draft.kind === "login") await validateWebsitePatterns(draft.uris);
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
      if (
        next.kind === "login" &&
        existing?.kind === "login" &&
        existing.password !== next.password
      ) {
        next = { ...next, passwordChangedAt: new Date().toISOString() };
      }
      await store.saveItem(next, location.folder);
      if (deliveryId) {
        await acknowledgeCertificateDelivery(deliveryId);
        setPendingDeliveryId(undefined);
      }
      if (next.kind === "secret" && next.connectionRef) {
        try {
          await compileSecretToHost(next);
        } catch {
          setError(
            "Saved on this device. Host grant compile failed — Host may be disconnected.",
          );
        }
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

  const closeTo = mode === "edit" ? `/vault/${draft.id}` : "/vault";
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
          onName={(name) => patch({ name })}
          onFolder={(folderId) => patch({ folderId })}
          onBlur={path.blur}
          typeId={draftTypeId}
          onTypeChange={onTypeChange}
          focusName
        />
        {mode === "new" ? (
          <DraftSuggestions
            key={`${draftTypeId}:${draft.kind === "login" ? draft.uris[0]?.uri : ""}`}
            typeId={draftTypeId}
            website={draft.kind === "login" ? draft.uris[0]?.uri : undefined}
            onApply={(labels) => {
              patch({ name: labels.name });
              if (draft.kind === "login" || draft.kind === "passkey")
                patch({ username: labels.username });
              if (draft.kind === "typed" && acceptsDraftUsername(draftTypeId))
                patchValue("username", labels.username);
            }}
          />
        ) : null}
        {draft.kind === "login" ? (
          <div className="editor__grid">
            <LoginWebsites
              uris={draft.uris}
              onChange={(uris) => patch({ uris })}
            />
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                autoComplete="off"
                value={draft.username}
                onChange={(event) => patch({ username: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="editor__inline">
                <input
                  id="password"
                  type={reveal ? "text" : "password"}
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(event) => patch({ password: event.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setReveal((value) => !value)}
                  aria-label={reveal ? "Hide password" : "Show password"}
                >
                  {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
                </button>
                <button
                  type="button"
                  className={`icon-btn${showGenerator ? " is-on" : ""}`}
                  onClick={() => setShowGenerator((value) => !value)}
                  aria-expanded={showGenerator}
                  aria-label="Password generator"
                  title="Password generator"
                >
                  <IconRefresh size={17} />
                </button>
              </div>
            </div>

            {showGenerator ? (
              <PasswordGenerator
                onUse={(value) => {
                  patch({ password: value });
                  setShowGenerator(false);
                  setReveal(true);
                }}
                onDismiss={() => setShowGenerator(false)}
              />
            ) : null}

            <OptionalField
              key={draft.id}
              present={Boolean(draft.totp)}
              command="Add authenticator secret"
            >
              <div className="field">
                <label htmlFor="totp">Authenticator secret</label>
                <input
                  id="totp"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Base32 seed or otpauth:// URI"
                  value={draft.totp}
                  onChange={(event) => patch({ totp: event.target.value })}
                />
              </div>
            </OptionalField>
          </div>
        ) : null}

        {draft.kind === "secret" ? (
          <div className="editor__grid">
            <div className="field">
              <label htmlFor="secret-value">Secret value</label>
              <div className="editor__inline">
                <input
                  id="secret-value"
                  type={reveal ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.value}
                  onChange={(event) => patch({ value: event.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setReveal((value) => !value)}
                  aria-label={reveal ? "Hide secret" : "Show secret"}
                >
                  {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
                </button>
              </div>
            </div>
            <OptionalField
              present={Boolean(draft.connectionRef)}
              command="Add connection reference"
            >
              <div className="field">
                <label htmlFor="connref">Connection reference</label>
                <input
                  id="connref"
                  spellCheck={false}
                  placeholder="conn_…"
                  value={draft.connectionRef}
                  onChange={(event) =>
                    patch({ connectionRef: event.target.value })
                  }
                />
              </div>
            </OptionalField>
            <div className="field">
              <GroupAdd
                label="Capability ceiling"
                action="Add capability"
                onAdd={() => patch({ ceiling: [...draft.ceiling, newGrant()] })}
              />
              {draft.ceiling.map((grant, index) => (
                <div className="editor__ceiling" key={grant.id}>
                  <input
                    value={grant.action}
                    placeholder="http.post"
                    aria-label={`Action ${index + 1}`}
                    onChange={(event) =>
                      patch({
                        ceiling: draft.ceiling.map((candidate) =>
                          candidate.id === grant.id
                            ? { ...candidate, action: event.target.value }
                            : candidate,
                        ),
                      })
                    }
                  />
                  <input
                    value={grant.resource}
                    placeholder="https://deploy.example.com/hooks/release"
                    aria-label={`Resource ${index + 1}`}
                    onChange={(event) =>
                      patch({
                        ceiling: draft.ceiling.map((candidate) =>
                          candidate.id === grant.id
                            ? { ...candidate, resource: event.target.value }
                            : candidate,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove capability ${index + 1}`}
                    onClick={() =>
                      patch({
                        ceiling: draft.ceiling.filter(
                          (candidate) => candidate.id !== grant.id,
                        ),
                      })
                    }
                  >
                    <IconX size={17} />
                  </button>
                </div>
              ))}
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
          <p className="hint">
            The definition for this type is not installed on this device. Its
            stored values are untouched; install the type from Settings to edit
            them.
          </p>
        ) : null}

        <EditorExtras key={draft.id} draft={draft} onChange={patch} />

        {error ? (
          <p className="note note--err" role="alert">
            <span>{error}</span>
          </p>
        ) : null}
        <EditorActions busy={saving} label={saveVerb} closeTo={closeTo} />
      </form>
    </div>
  );
}
