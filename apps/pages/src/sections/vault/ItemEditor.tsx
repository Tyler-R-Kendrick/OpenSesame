import { overlapCast } from "@opensesame/os-domain";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  IconCheck,
  IconChevronLeft,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconRefresh,
  IconX,
} from "../../components/Icons.js";
import { PasswordGenerator } from "../../components/PasswordGenerator.js";
import {
  acknowledgeCertificateDelivery,
  issueCertificate,
} from "../../lib/certs.js";
import { compileSecretToHost } from "../../lib/connections.js";
import { isTouchPointer } from "../../lib/gestures.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  type CustomField,
  type ItemKind,
  type UriMatch,
  type VaultItem,
  createItem,
  newGrant,
  newId,
  newUri,
} from "../../lib/vault/model.js";
import { KIND_EXT } from "../../lib/vault/paths.js";
import { NewDropCeremony } from "./DropCeremony.js";

const KINDS: ItemKind[] = [
  "login",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];
const MATCHES: UriMatch[] = ["domain", "host", "exact", "never"];

/** Group heading with its one action beside it: a label and a + key. */
function GroupAdd({
  label,
  action,
  onAdd,
}: {
  label: string;
  action: string;
  onAdd: () => void;
}) {
  return (
    <span className="label editor__grouplabel">
      {label}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={action}
        title={action}
        onClick={onAdd}
      >
        <IconPlus size={15} />
      </button>
    </span>
  );
}

function isKind(value: string | undefined): value is ItemKind {
  return value !== undefined && KINDS.some((kind) => kind === value);
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
  const [pendingDeliveryId, setPendingDeliveryId] = useState<string>();
  const [issuanceKey, setIssuanceKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    setDraft(initial);
    setShowGenerator(false);
    setReveal(false);
    setPendingDeliveryId(undefined);
    setIssuanceKey(crypto.randomUUID());
  }, [initial]);

  if (!draft) {
    return (
      <div className="detail">
        <div className="empty">
          <h2>Nothing to edit</h2>
          <p>That item is no longer in this vault.</p>
          <Link className="btn btn--sm" to="/vault">
            Back to the vault
          </Link>
        </div>
      </div>
    );
  }

  // A drop is a one-time share in flight, not an editable item: +new gets its
  // own ceremony, and an existing record has nothing an editor could change.
  if (draft.kind === "drop") {
    if (mode === "new") return <NewDropCeremony />;
    return (
      <div className="detail">
        <div className="empty">
          <h2>Drops cannot be edited</h2>
          <p>
            A drop is sealed when it is created. Its record shows the state and
            disappears once the drop is opened or lapses.
          </p>
          <Link className="btn btn--sm" to={`/vault/${draft.id}`}>
            Back to the drop
          </Link>
        </div>
      </div>
    );
  }

  const patch = (changes: Partial<VaultItem>) =>
    setDraft((current) =>
      current ? overlapCast({ ...current, ...changes }) : current,
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() && draft.kind !== "certificate") {
      setError("Give this item a name so you can find it again.");
      return;
    }
    setSaving(true);
    setError(null);
    let deliveryId = pendingDeliveryId;
    try {
      let next = draft;
      if (next.kind === "certificate" && !next.certificatePem) {
        const issued = await issueCertificate({
          commonName: next.commonName.trim() || "localhost",
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
      await store.saveItem(next);
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

  function setField(id: string, changes: Partial<CustomField>) {
    if (!draft) return;
    patch(
      overlapCast({
        fields: draft.fields.map((field) =>
          field.id === id ? { ...field, ...changes } : field,
        ),
      }),
    );
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
        {/* The editor edits a file: its name is the title, its kind the
            extension, and save/cancel are keys in the title row. */}
        <div className="editor__titlerow">
          <Link
            className="icon-btn editor__backbtn"
            aria-label="Back"
            title="Back"
            to={closeTo}
          >
            <IconChevronLeft size={17} />
          </Link>
          <input
            className="editor__name"
            aria-label="Name"
            placeholder="Untitled"
            value={draft.name}
            // biome-ignore lint/a11y/noAutofocus: reached only by an explicit "new item" or "edit" action, where the name is the first thing to type — but never on a phone, where it would throw the keyboard over the record before it can be read
            autoFocus={!isTouchPointer()}
            onChange={(event) => patch({ name: event.target.value })}
          />
          {mode === "new" ? (
            <select
              className="editor__ext"
              aria-label="Type"
              value={draft.kind}
              onChange={(event) => {
                const next = createItem(
                  overlapCast(event.target.value),
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
                  {KIND_EXT[kind]}
                </option>
              ))}
            </select>
          ) : (
            <span className="editor__ext" aria-hidden="true">
              {KIND_EXT[draft.kind]}
            </span>
          )}
          <button
            type="submit"
            className="icon-btn editor__save"
            disabled={saving}
            aria-busy={saving}
            aria-label={saveVerb}
            title={saveVerb}
          >
            <IconCheck size={17} />
          </button>
          <Link
            className="icon-btn"
            aria-label="Cancel"
            title="Cancel"
            to={closeTo}
          >
            <IconX size={17} />
          </Link>
        </div>
        <p className="hint editor__seal">
          {draft.kind === "certificate"
            ? "The Host issues the certificate; the returned material is sealed in this device vault."
            : "Saving re-seals the whole vault under your master key. Nothing leaves this device."}
        </p>

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
              <GroupAdd
                label="Websites"
                action="Add address"
                onAdd={() => patch({ uris: [...draft.uris, newUri()] })}
              />
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
                                match: overlapCast(event.target.value),
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
                    authenticator: overlapCast(event.target.value),
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
                The ConnectionRef a grant of this secret targets. The value
                never leaves the vault.
              </p>
            </div>
            <div className="field">
              <label htmlFor="grantees">Grantees (agent ids)</label>
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
              <p className="hint">
                Optional — only matters when granting this secret to an agent.
              </p>
            </div>
            <div className="field">
              <GroupAdd
                label="Capability ceiling"
                action="Add capability"
                onAdd={() => patch({ ceiling: [...draft.ceiling, newGrant()] })}
              />
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
            </div>
          </div>
        ) : null}

        {draft.kind === "certificate" ? (
          <div className="editor__grid">
            <p className="hint">
              {draft.certificatePem
                ? "Certificate material was generated by the Host and is available from the item detail. Create a new certificate to change its signed names or lifetime."
                : "OpenSesame generates an ECDSA P-256 private key and issues a short-lived TLS certificate from your configured issuer, or its private CA by default. You never need to paste certificate material."}
            </p>
            <div className="field">
              <label htmlFor="cert-cn">Common name</label>
              <input
                id="cert-cn"
                value={draft.commonName}
                readOnly={Boolean(draft.certificatePem)}
                onChange={(event) => patch({ commonName: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="cert-dns">DNS names</label>
              <input
                id="cert-dns"
                value={draft.dnsNames}
                placeholder="localhost, *.local"
                readOnly={Boolean(draft.certificatePem)}
                onChange={(event) => patch({ dnsNames: event.target.value })}
              />
            </div>
            <div className="editor__row">
              <div className="field">
                <label htmlFor="cert-ip">IP addresses</label>
                <input
                  id="cert-ip"
                  value={draft.ipAddrs}
                  placeholder="127.0.0.1"
                  readOnly={Boolean(draft.certificatePem)}
                  onChange={(event) => patch({ ipAddrs: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="cert-ttl">TTL (hours)</label>
                <input
                  id="cert-ttl"
                  inputMode="numeric"
                  value={draft.ttlHours}
                  readOnly={Boolean(draft.certificatePem)}
                  onChange={(event) => patch({ ttlHours: event.target.value })}
                />
              </div>
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
          <GroupAdd
            label="Custom fields"
            action="Add field"
            onAdd={() =>
              patch({
                fields: [
                  ...draft.fields,
                  { id: newId(), name: "", value: "", hidden: false },
                ],
              })
            }
          />
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
      </form>
    </div>
  );
}
