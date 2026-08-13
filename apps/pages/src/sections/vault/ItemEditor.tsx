import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  IconChevronLeft,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconRefresh,
  IconX,
} from "../../components/Icons.js";
import { PasswordGenerator } from "../../components/PasswordGenerator.js";
import { compileSecretToHost } from "../../lib/connections.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  type CustomField,
  type ItemKind,
  KIND_LABEL,
  type UriMatch,
  type VaultItem,
  createItem,
  newGrant,
  newId,
  newUri,
} from "../../lib/vault/model.js";

const KINDS: ItemKind[] = ["login", "passkey", "card", "secret", "note"];
const MATCHES: UriMatch[] = ["domain", "host", "exact", "never"];

function isKind(value: string | undefined): value is ItemKind {
  return value !== undefined && (KINDS as string[]).includes(value);
}

export function ItemEditor({ mode }: { mode: "new" | "edit" }) {
  const { kind: kindParam, itemId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { items, folders } = useVault();
  const store = useVaultStore();

  const existing = items.find((candidate) => candidate.id === itemId);
  const initial = useMemo<VaultItem | null>(() => {
    if (mode === "edit") return existing ?? null;
    const draft = createItem(isKind(kindParam) ? kindParam : "login");
    const name = search.get("name")?.trim();
    const uri = search.get("uri")?.trim();
    const ref = search.get("ref")?.trim();
    if (name) draft.name = name;
    if (draft.kind === "login" && uri) {
      draft.uris = [newUri(uri)];
    }
    if (draft.kind === "secret" && ref) {
      draft.connectionRef = ref;
    }
    if (draft.kind === "passkey" && uri) {
      try {
        draft.rpId = new URL(uri.includes("://") ? uri : `https://${uri}`).host;
      } catch {
        draft.rpId = uri;
      }
    }
    return draft;
  }, [mode, existing, kindParam, search]);

  const [draft, setDraft] = useState<VaultItem | null>(initial);
  const [showGenerator, setShowGenerator] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setShowGenerator(false);
    setReveal(false);
  }, [initial]);

  if (!draft) {
    return (
      <div className="detail">
        <div className="empty">
          <h3>Nothing to edit</h3>
          <p>That item is no longer in this vault.</p>
          <Link className="btn btn--sm" to="/vault">
            Back to the vault
          </Link>
        </div>
      </div>
    );
  }

  const patch = (changes: Partial<VaultItem>) =>
    setDraft((current) =>
      current ? ({ ...current, ...changes } as VaultItem) : current,
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Give this item a name so you can find it again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let next = draft;
      if (
        next.kind === "login" &&
        existing?.kind === "login" &&
        existing.password !== next.password
      ) {
        next = { ...next, passwordChangedAt: new Date().toISOString() };
      }
      await store.saveItem(next);
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

  function setField(id: string, changes: Partial<CustomField>) {
    if (!draft) return;
    patch({
      fields: draft.fields.map((field) =>
        field.id === id ? { ...field, ...changes } : field,
      ),
    } as Partial<VaultItem>);
  }

  return (
    <div className="detail">
      <Link
        className="btn btn--ghost btn--sm detail__back"
        to={mode === "edit" ? `/vault/${draft.id}` : "/vault"}
      >
        <IconChevronLeft size={16} />
        Back
      </Link>

      <div className="detail__heading">
        <h1>
          {mode === "new"
            ? `New ${KIND_LABEL[draft.kind].toLowerCase()}`
            : "Edit item"}
        </h1>
        <p className="hint">
          Saving re-seals the whole vault under your master key. Nothing leaves
          this device.
        </p>
      </div>

      <form className="editor" onSubmit={(event) => void onSubmit(event)}>
        {mode === "new" ? (
          <div className="field">
            <label htmlFor="kind">Type</label>
            <select
              id="kind"
              value={draft.kind}
              onChange={(event) => {
                const next = createItem(
                  event.target.value as ItemKind,
                  draft.name,
                );
                setDraft({
                  ...next,
                  folderId: draft.folderId,
                  notes: draft.notes,
                });
              }}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            value={draft.name}
            // biome-ignore lint/a11y/noAutofocus: reached only by an explicit "new item" or "edit" action, where the name is the first thing to type
            autoFocus
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>

        {draft.kind === "login" ? (
          <div className="editor__grid">
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
              <p className="hint">
                Codes are computed here from this seed. Nothing is sent
                anywhere.
              </p>
            </div>

            <div className="field">
              <span className="label">Websites</span>
              {draft.uris.map((uri, index) => (
                <div className="editor__uri" key={uri.id}>
                  <input
                    value={uri.uri}
                    placeholder="https://example.com"
                    aria-label={`Address ${index + 1}`}
                    onChange={(event) =>
                      patch({
                        uris: draft.uris.map((candidate) =>
                          candidate.id === uri.id
                            ? { ...candidate, uri: event.target.value }
                            : candidate,
                        ),
                      })
                    }
                  />
                  <select
                    value={uri.match}
                    aria-label={`Match rule ${index + 1}`}
                    onChange={(event) =>
                      patch({
                        uris: draft.uris.map((candidate) =>
                          candidate.id === uri.id
                            ? {
                                ...candidate,
                                match: event.target.value as UriMatch,
                              }
                            : candidate,
                        ),
                      })
                    }
                  >
                    {MATCHES.map((match) => (
                      <option key={match} value={match}>
                        {match}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove address ${index + 1}`}
                    onClick={() =>
                      patch({
                        uris: draft.uris.filter(
                          (candidate) => candidate.id !== uri.id,
                        ),
                      })
                    }
                  >
                    <IconX size={17} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => patch({ uris: [...draft.uris, newUri()] })}
              >
                <IconPlus size={15} />
                Add address
              </button>
            </div>
          </div>
        ) : null}

        {draft.kind === "passkey" ? (
          <div className="editor__grid">
            <div className="editor__row">
              <div className="field">
                <label htmlFor="rpid">Relying party</label>
                <input
                  id="rpid"
                  placeholder="example.com"
                  value={draft.rpId}
                  onChange={(event) => patch({ rpId: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="pk-user">Account</label>
                <input
                  id="pk-user"
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="authenticator">Authenticator</label>
              <select
                id="authenticator"
                value={draft.authenticator}
                onChange={(event) =>
                  patch({
                    authenticator: event.target.value as
                      | "platform"
                      | "cross-platform",
                  })
                }
              >
                <option value="platform">This device</option>
                <option value="cross-platform">
                  Security key or another device
                </option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="credid">Credential id</label>
              <input
                id="credid"
                spellCheck={false}
                value={draft.credentialIdB64}
                onChange={(event) =>
                  patch({ credentialIdB64: event.target.value })
                }
              />
            </div>
            <p className="note">
              <span>
                This records a credential; it does not create one. The private
                key stays in the authenticator and never enters the vault.
              </span>
            </p>
          </div>
        ) : null}

        {draft.kind === "card" ? (
          <div className="editor__grid">
            <div className="editor__row">
              <div className="field">
                <label htmlFor="cardholder">Cardholder</label>
                <input
                  id="cardholder"
                  autoComplete="off"
                  value={draft.cardholder}
                  onChange={(event) =>
                    patch({ cardholder: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="brand">Brand</label>
                <input
                  id="brand"
                  autoComplete="off"
                  value={draft.brand}
                  onChange={(event) => patch({ brand: event.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="number">Number</label>
              <input
                id="number"
                inputMode="numeric"
                autoComplete="off"
                value={draft.number}
                onChange={(event) =>
                  patch({ number: event.target.value.replace(/[^\d]/g, "") })
                }
              />
            </div>
            <div className="editor__row">
              <div className="field">
                <label htmlFor="exp">Expires</label>
                <div className="editor__inline">
                  <input
                    id="exp"
                    inputMode="numeric"
                    placeholder="MM"
                    maxLength={2}
                    value={draft.expMonth}
                    onChange={(event) =>
                      patch({ expMonth: event.target.value })
                    }
                  />
                  <input
                    inputMode="numeric"
                    placeholder="YYYY"
                    maxLength={4}
                    aria-label="Expiry year"
                    value={draft.expYear}
                    onChange={(event) => patch({ expYear: event.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="cvc">Security code</label>
                <input
                  id="cvc"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={draft.code}
                  onChange={(event) => patch({ code: event.target.value })}
                />
              </div>
            </div>
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
              <p className="hint">
                What the Host plane invokes with. Agents pass the reference;
                they never see the value.
              </p>
            </div>
            <div className="field">
              <label htmlFor="grantees">
                Agents permitted to request a grant
              </label>
              <input
                id="grantees"
                spellCheck={false}
                placeholder="agt_release_bot, agt_indexer"
                value={draft.grantees.join(", ")}
                onChange={(event) =>
                  patch({
                    grantees: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
            <div className="field">
              <span className="label">Capability ceiling</span>
              <p className="hint">
                The outer bound of what any grant against this secret may do. A
                task can hold less than this; it can never hold more.
              </p>
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
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  patch({ ceiling: [...draft.ceiling, newGrant()] })
                }
              >
                <IconPlus size={15} />
                Add capability
              </button>
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            value={draft.notes}
            rows={draft.kind === "note" ? 12 : 4}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </div>

        <div className="field">
          <span className="label">Custom fields</span>
          {draft.fields.map((field) => (
            <div className="editor__uri" key={field.id}>
              <input
                value={field.name}
                placeholder="Field name"
                aria-label="Field name"
                onChange={(event) =>
                  setField(field.id, { name: event.target.value })
                }
              />
              <input
                type={field.hidden ? "password" : "text"}
                value={field.value}
                placeholder="Value"
                aria-label="Field value"
                onChange={(event) =>
                  setField(field.id, { value: event.target.value })
                }
              />
              <div className="editor__inline">
                <button
                  type="button"
                  className={`icon-btn${field.hidden ? " is-on" : ""}`}
                  aria-pressed={field.hidden}
                  aria-label="Conceal this field"
                  title="Conceal this field"
                  onClick={() => setField(field.id, { hidden: !field.hidden })}
                >
                  {field.hidden ? (
                    <IconEyeOff size={17} />
                  ) : (
                    <IconEye size={17} />
                  )}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${field.name || "field"}`}
                  onClick={() =>
                    patch({
                      fields: draft.fields.filter(
                        (candidate) => candidate.id !== field.id,
                      ),
                    })
                  }
                >
                  <IconX size={17} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              patch({
                fields: [
                  ...draft.fields,
                  { id: newId(), name: "", value: "", hidden: false },
                ],
              })
            }
          >
            <IconPlus size={15} />
            Add field
          </button>
        </div>

        <div className="editor__row">
          <div className="field">
            <label htmlFor="folder">Folder</label>
            <select
              id="folder"
              value={draft.folderId ?? ""}
              onChange={(event) =>
                patch({ folderId: event.target.value || null })
              }
            >
              <option value="">No folder</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="label">Favorite</span>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.favorite}
                onChange={(event) => patch({ favorite: event.target.checked })}
              />
              <span>Pin to the top of the list</span>
            </label>
          </div>
        </div>

        {error ? (
          <p className="note note--err" role="alert">
            <span>{error}</span>
          </p>
        ) : null}

        <div className="editor__bar">
          <Link
            className="btn"
            to={mode === "edit" ? `/vault/${draft.id}` : "/vault"}
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? "Sealing…" : "Save item"}
          </button>
        </div>
      </form>
    </div>
  );
}
