import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import {
  IconCheck,
  IconCopy,
  IconExternal,
  IconStar,
} from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { TotpCode, currentTotp } from "../../components/TotpCode.js";
import { connectionEvents, listConnections } from "../../lib/connections.js";
import { usePlaneStatus } from "../../lib/planes.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  type ItemKind,
  KIND_LABEL,
  type VaultItem,
  browsableUrl,
  hostOf,
  isVaultCustodied,
} from "../../lib/vault/model.js";
import { estimateStrength, generate } from "../../lib/vault/password.js";
import { totpSetupUri } from "../../lib/vault/totp.js";
import { DropRecordFields, ShareSecretDrop } from "./DropCeremony.js";

const STRENGTH_VARS = ["--s-0", "--s-1", "--s-2", "--s-3", "--s-4"] as const;

function StrengthBar({ password }: { password: string }) {
  const strength = estimateStrength(password);
  const color = `var(${STRENGTH_VARS[strength.score]})`;
  return (
    <div className="sbar">
      <div className="sbar__track" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            style={
              index <= strength.score - 1 ? { background: color } : undefined
            }
          />
        ))}
      </div>
      <span className="sbar__label" style={{ color }}>
        {strength.label} · ≈{strength.bits} bits
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ItemDetail() {
  const { itemId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // The active filter travels in the query string, so going back keeps it.
  const listPath = `/vault${location.search}`;
  const { items, folders } = useVault();
  const store = useVaultStore();
  const { copied, failed, copy } = useCopyFeedback();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirmPurge, setConfirmPurge] = useState(false);

  const item = items.find((candidate) => candidate.id === itemId);

  // Re-conceal every value when the selected item changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemId is the trigger, not an input — a revealed secret must not survive a move to another item
  useEffect(() => {
    setRevealed(new Set());
    setConfirmPurge(false);
  }, [itemId]);

  if (!item) {
    return (
      <div className="detail">
        <div className="empty">
          <h2>That item is not in this vault</h2>
          <p>
            It may have been purged, or the link points at another device's
            vault.
          </p>
          <Link className="btn btn--sm" to={listPath}>
            Back to the vault
          </Link>
        </div>
      </div>
    );
  }

  const toggle = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const folder = folders.find((candidate) => candidate.id === item.folderId);
  const inTrash = item.deletedAt !== null;

  return (
    <div className="detail">
      <Link className="btn btn--ghost btn--sm detail__back" to={listPath}>
        {listPath === "/vault" ? "← All items" : "← Back to list"}
      </Link>

      <div className="detail__head">
        <div className="detail__heading">
          <h1>{item.name || "Untitled"}</h1>
          <div className="detail__meta">
            <span>{KIND_LABEL[item.kind]}</span>
            {folder ? (
              <Link to={`/vault?folder=${encodeURIComponent(folder.id)}`}>
                {folder.name}
              </Link>
            ) : null}
            <span>Updated {formatDate(item.updatedAt)}</span>
            {item.sample ? (
              <span className="chip chip--sample">SYNTHETIC</span>
            ) : null}
            {inTrash ? <span className="chip chip--warn">In trash</span> : null}
          </div>
        </div>
        <div className="detail__tools">
          <button
            type="button"
            className={`icon-btn${item.favorite ? " is-on" : ""}`}
            onClick={() => void store.toggleFavorite(item.id)}
            aria-pressed={item.favorite}
            aria-label={
              item.favorite ? "Remove from favorites" : "Add to favorites"
            }
            title={item.favorite ? "Remove from favorites" : "Add to favorites"}
          >
            <IconStar size={17} filled={item.favorite} />
          </button>
        </div>
      </div>

      {inTrash ? (
        <div className="note note--warn">
          <span>
            This item is in the trash. It stays encrypted until you purge it.
          </span>
        </div>
      ) : null}

      <ItemFields
        item={item}
        revealed={revealed}
        toggle={toggle}
        copied={copied}
        failed={failed}
        copy={copy}
        shareInitiallyOpen={
          new URLSearchParams(location.search).get("share") === "drop"
        }
        onUpdateSecret={async (next) => {
          const updated = { ...item, updatedAt: new Date().toISOString() };
          if (updated.kind === "login") {
            updated.password = next;
            updated.passwordChangedAt = new Date().toISOString();
          } else if (updated.kind === "secret") {
            updated.value = next;
          }
          await store.saveItem(updated);
        }}
      />

      {item.fields.length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Custom fields</h2>
          {item.fields.map((field) => (
            <FieldRow
              key={field.id}
              label={field.name || "Field"}
              actions={
                <>
                  {field.hidden ? (
                    <RevealButton
                      revealed={revealed.has(field.id)}
                      label={field.name}
                      onToggle={() => toggle(field.id)}
                    />
                  ) : null}
                  <CopyButton
                    value={field.value}
                    label={field.name}
                    fieldKey={field.id}
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              {field.hidden ? (
                <ConcealedValue
                  value={field.value}
                  label={field.name}
                  revealed={revealed.has(field.id)}
                />
              ) : (
                <span className="frow__value">{field.value}</span>
              )}
            </FieldRow>
          ))}
        </section>
      ) : null}

      {item.notes && item.kind !== "note" ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Notes</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes}</p>
          </div>
        </section>
      ) : null}

      <div className="actions">
        {inTrash ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => void store.restoreItem(item.id)}
            >
              Restore
            </button>
            {confirmPurge ? (
              <>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    void store.purgeItem(item.id);
                    navigate("/vault?f=trash");
                  }}
                >
                  Purge permanently
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmPurge(false)}
                >
                  Cancel
                </button>
                <span className="hint">This cannot be undone.</span>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => setConfirmPurge(true)}
              >
                Delete permanently
              </button>
            )}
          </>
        ) : (
          <>
            {item.kind !== "drop" ? (
              <Link className="btn btn--primary" to={`/vault/${item.id}/edit`}>
                Edit
              </Link>
            ) : null}
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                void store.trashItem(item.id);
                navigate(listPath);
              }}
            >
              Move to trash
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type FieldsProps = {
  item: VaultItem;
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
  /** A `?share=drop` deep link (e.g. from a list row) opens the ceremony. */
  shareInitiallyOpen: boolean;
  onUpdateSecret: (next: string) => Promise<void>;
};

function UpdateSecretPanel({
  label,
  onUpdate,
}: {
  label: string;
  onUpdate: (next: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"generate" | "provide">("generate");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setError(null);
    setBusy(true);
    try {
      const next =
        mode === "generate"
          ? generate({
              mode: "characters",
              length: 32,
              lower: true,
              upper: true,
              digits: true,
              symbols: true,
              avoidAmbiguous: true,
            })
          : value;
      if (!next) throw new Error("Enter a new value.");
      await onUpdate(next);
      setOpen(false);
      setValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => setOpen(true)}
      >
        Update {label}
      </button>
    );
  }

  return (
    <div className="detail__update">
      <fieldset className="sites-effect-toggle" aria-label="Update mode">
        <button
          type="button"
          className={
            mode === "generate" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          onClick={() => setMode("generate")}
        >
          Generate
        </button>
        <button
          type="button"
          className={
            mode === "provide" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          onClick={() => setMode("provide")}
        >
          Enter
        </button>
      </fieldset>
      {mode === "provide" ? (
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          placeholder={`New ${label}`}
          aria-label={`New ${label}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <p className="hint">Generates a 32-character password and saves it.</p>
      )}
      {error ? (
        <p className="note note--err" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={() => void apply()}
        >
          {busy ? "Saving…" : "Save new value"}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ItemFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
  shareInitiallyOpen,
  onUpdateSecret,
}: FieldsProps) {
  switch (item.kind) {
    case "login":
      return (
        <>
          <section className="detail__group">
            <h2 className="detail__grouphead">Credentials</h2>
            {item.username ? (
              <FieldRow
                label="Username"
                actions={
                  <CopyButton
                    value={item.username}
                    label="username"
                    fieldKey="username"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                }
              >
                <span className="frow__value">{item.username}</span>
              </FieldRow>
            ) : null}

            {item.password ? (
              <FieldRow
                label="Password"
                actions={
                  <>
                    <RevealButton
                      revealed={revealed.has("password")}
                      label="password"
                      onToggle={() => toggle("password")}
                    />
                    <CopyButton
                      value={item.password}
                      label="password"
                      fieldKey="password"
                      copied={copied}
                      failed={failed}
                      onCopy={copy}
                    />
                  </>
                }
              >
                <ConcealedValue
                  value={item.password}
                  label="password"
                  revealed={revealed.has("password")}
                />
                {revealed.has("password") ? (
                  <StrengthBar password={item.password} />
                ) : null}
                <UpdateSecretPanel label="password" onUpdate={onUpdateSecret} />
              </FieldRow>
            ) : (
              <UpdateSecretPanel label="password" onUpdate={onUpdateSecret} />
            )}

            {item.totp ? (
              <>
                <FieldRow
                  label="Authenticator code"
                  actions={
                    <button
                      type="button"
                      className={`icon-btn${copied === "totp" ? " is-on" : ""}`}
                      onClick={() => {
                        void currentTotp(item.totp)
                          .then((code) => copy("totp", code))
                          .catch(() => undefined);
                      }}
                      aria-label="Copy current code"
                      title="Copy current code"
                    >
                      {copied === "totp" ? (
                        <IconCheck size={17} />
                      ) : (
                        <IconCopy size={17} />
                      )}
                    </button>
                  }
                >
                  <TotpCode secret={item.totp} />
                </FieldRow>
                <FieldRow
                  label="Setup QR"
                  actions={
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => toggle("totp-qr")}
                    >
                      {revealed.has("totp-qr") ? "Hide" : "Show"}
                    </button>
                  }
                >
                  {revealed.has("totp-qr") ? (
                    <div className="detail__totp-qr">
                      <QrCode
                        value={totpSetupUri(item.totp, {
                          label: item.name || "OpenSesame",
                          issuer: "OpenSesame",
                        })}
                        label="Scan to enroll this authenticator secret in an authenticator app"
                        size={144}
                      />
                      <p className="hint">
                        Scan with an authenticator app. The QR encodes the same
                        seed that powers the code above.
                      </p>
                    </div>
                  ) : (
                    <span className="frow__value frow__value--muted">
                      Hidden — shows the otpauth enrollment QR.
                    </span>
                  )}
                </FieldRow>
              </>
            ) : null}
          </section>

          {item.uris.length > 0 ? (
            <section className="detail__group">
              <h2 className="detail__grouphead">Websites</h2>
              {item.uris.map((uri) => {
                const href = browsableUrl(uri.uri);
                return (
                  <FieldRow
                    key={uri.id}
                    label={`Match: ${uri.match}`}
                    actions={
                      <>
                        {href ? (
                          <a
                            className="icon-btn"
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                            aria-label={`Open ${hostOf(uri.uri) || uri.uri}`}
                            title="Open in a new tab"
                          >
                            <IconExternal size={17} />
                          </a>
                        ) : null}
                        <CopyButton
                          value={uri.uri}
                          label="address"
                          fieldKey={`uri-${uri.id}`}
                          copied={copied}
                          failed={failed}
                          onCopy={copy}
                        />
                      </>
                    }
                  >
                    <span className="frow__value">{uri.uri}</span>
                  </FieldRow>
                );
              })}
            </section>
          ) : null}

          <p className="hint">
            Password last changed {formatDate(item.passwordChangedAt)}.
          </p>
        </>
      );

    case "passkey": {
      const vaultCustodied = isVaultCustodied(item);
      return (
        <>
          <section className="detail__group">
            <h2 className="detail__grouphead">Credential</h2>
            <FieldRow label="Relying party">
              <span className="frow__value">{item.rpId || "—"}</span>
            </FieldRow>
            {item.username ? (
              <FieldRow label="Account">
                <span className="frow__value">{item.username}</span>
              </FieldRow>
            ) : null}
            <FieldRow label="Authenticator">
              <span className="frow__value">
                {vaultCustodied
                  ? "OpenSesame synced passkey"
                  : item.authenticator === "platform"
                    ? "This device or platform provider"
                    : "Security key or another device"}
              </span>
            </FieldRow>
            {item.credentialIdB64 ? (
              <FieldRow
                label="Credential id"
                actions={
                  <CopyButton
                    value={item.credentialIdB64}
                    label="credential id"
                    fieldKey="credid"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                }
              >
                <span className="frow__value frow__value--mono">
                  {item.credentialIdB64}
                </span>
              </FieldRow>
            ) : null}
            <FieldRow label="Unlocks this vault">
              <span className="frow__value">
                {item.unlocksVault ? "Yes, via WebAuthn PRF" : "No"}
              </span>
            </FieldRow>
          </section>
          <div className="note">
            <span>
              {vaultCustodied
                ? "OpenSesame holds this passkey's encrypted private key and can answer system credential-provider requests after device authentication."
                : "This is a metadata-only record for a passkey held by another authenticator. OpenSesame cannot use it to sign in."}
            </span>
          </div>
        </>
      );
    }

    case "card":
      return (
        <section className="detail__group">
          <h2 className="detail__grouphead">Card</h2>
          {item.cardholder ? (
            <FieldRow label="Cardholder">
              <span className="frow__value">{item.cardholder}</span>
            </FieldRow>
          ) : null}
          {item.brand ? (
            <FieldRow label="Brand">
              <span className="frow__value">{item.brand}</span>
            </FieldRow>
          ) : null}
          {item.number ? (
            <FieldRow
              label="Number"
              actions={
                <>
                  <RevealButton
                    revealed={revealed.has("number")}
                    label="card number"
                    onToggle={() => toggle("number")}
                  />
                  <CopyButton
                    value={item.number}
                    label="card number"
                    fieldKey="number"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              {revealed.has("number") ? (
                <span className="frow__value frow__value--mono">
                  {item.number.replace(/(.{4})/g, "$1 ").trim()}
                </span>
              ) : (
                <span className="conceal">
                  •••• •••• •••• {item.number.slice(-4)}
                </span>
              )}
            </FieldRow>
          ) : null}
          {item.expMonth || item.expYear ? (
            <FieldRow label="Expires">
              <span className="frow__value frow__value--mono">
                {item.expMonth || "--"}/{item.expYear || "----"}
              </span>
            </FieldRow>
          ) : null}
          {item.code ? (
            <FieldRow
              label="Security code"
              actions={
                <>
                  <RevealButton
                    revealed={revealed.has("code")}
                    label="security code"
                    onToggle={() => toggle("code")}
                  />
                  <CopyButton
                    value={item.code}
                    label="security code"
                    fieldKey="code"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              <ConcealedValue
                value={item.code}
                label="security code"
                revealed={revealed.has("code")}
              />
            </FieldRow>
          ) : null}
        </section>
      );

    case "secret":
      return (
        <>
          <section className="detail__group">
            <h2 className="detail__grouphead">Secret</h2>
            <FieldRow
              label="Value"
              actions={
                <>
                  <RevealButton
                    revealed={revealed.has("value")}
                    label="secret value"
                    onToggle={() => toggle("value")}
                  />
                  <CopyButton
                    value={item.value}
                    label="secret"
                    fieldKey="value"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              <ConcealedValue
                value={item.value}
                label="secret value"
                revealed={revealed.has("value")}
              />
              <UpdateSecretPanel label="secret" onUpdate={onUpdateSecret} />
            </FieldRow>
            {item.connectionRef ? (
              <FieldRow
                label="Connection reference"
                actions={
                  <CopyButton
                    value={item.connectionRef}
                    label="connection reference"
                    fieldKey="connref"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                }
              >
                <span className="frow__value frow__value--mono">
                  {item.connectionRef}
                </span>
              </FieldRow>
            ) : null}
            <FieldRow label="Grantees">
              <span className="frow__value">
                {item.grantees.length > 0 ? item.grantees.join(", ") : "None"}
              </span>
            </FieldRow>
          </section>

          <section className="detail__group">
            <h2 className="detail__grouphead">Capability ceiling</h2>
            {item.ceiling.length === 0 ? (
              <div className="frow">
                <p className="frow__notes">
                  No ceiling set. Optional grant metadata — it only matters when
                  granting this secret to an agent.
                </p>
              </div>
            ) : (
              item.ceiling.map((grant, index) => (
                <div className="ceil" key={`${grant.action}-${index}`}>
                  <span className="ceil__action">{grant.action}</span>
                  <span className="ceil__resource">{grant.resource}</span>
                </div>
              ))
            )}
          </section>

          <section className="detail__group">
            <h2 className="detail__grouphead">Last receipt</h2>
            <LastReceipt connectionRef={item.connectionRef} />
          </section>

          <div className="actions">
            {item.connectionRef ? (
              <Link
                className="btn btn--primary btn--sm"
                to={`/connections/${providerIdFromRef(item.connectionRef)}`}
              >
                Grant or invoke on the Host
              </Link>
            ) : (
              <Link className="btn btn--sm" to="/connections">
                Authorize a Host connector first
              </Link>
            )}
          </div>

          <ShareSecretDrop item={item} initialOpen={shareInitiallyOpen} />

          <div className="note">
            <span>
              You can reveal this value; an agent never can. An agent receives a
              ConnectionRef, invokes through the Host, and the Host returns a
              receipt. There is no getSecret().
            </span>
          </div>
        </>
      );

    case "drop":
      return <DropRecordFields item={item} />;

    case "note":
      return (
        <section className="detail__group">
          <h2 className="detail__grouphead">Note</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes || "This note is empty."}</p>
          </div>
        </section>
      );

    case "certificate":
      return (
        <>
          <section className="detail__group">
            <h2 className="detail__grouphead">Dev certificate</h2>
            <FieldRow label="Common name">
              <span className="frow__value">{item.commonName || "—"}</span>
            </FieldRow>
            <FieldRow label="DNS names">
              <span className="frow__value">{item.dnsNames || "—"}</span>
            </FieldRow>
            <FieldRow label="Expires">
              <span className="frow__value">{item.notAfter || "—"}</span>
            </FieldRow>
            {item.serial ? (
              <FieldRow label="Serial">
                <span className="frow__value">{item.serial}</span>
              </FieldRow>
            ) : null}
          </section>
          <section className="detail__group">
            <h2 className="detail__grouphead">Material</h2>
            <FieldRow
              label="Certificate"
              actions={
                item.certificatePem ? (
                  <CopyButton
                    value={item.certificatePem}
                    label="certificate"
                    fieldKey="cert"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                ) : null
              }
            >
              <span className="frow__value">
                {item.certificatePem ? "PEM on this device" : "Not issued"}
              </span>
            </FieldRow>
            <FieldRow
              label="Private key"
              actions={
                <>
                  <RevealButton
                    revealed={revealed.has("cert-key")}
                    label="private key"
                    onToggle={() => toggle("cert-key")}
                  />
                  {item.privateKeyPem ? (
                    <CopyButton
                      value={item.privateKeyPem}
                      label="private key"
                      fieldKey="cert-key"
                      copied={copied}
                      failed={failed}
                      onCopy={copy}
                    />
                  ) : null}
                </>
              }
            >
              <ConcealedValue
                value={item.privateKeyPem || "—"}
                label="private key"
                revealed={revealed.has("cert-key")}
              />
            </FieldRow>
            <p className="hint">
              Trust the Host dev CA on this machine for local TLS. The private
              key never leaves this vault for an agent.
            </p>
          </section>
        </>
      );
  }
}

function providerIdFromRef(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "github") : "github";
}

function LastReceipt({ connectionRef }: { connectionRef: string }) {
  const status = usePlaneStatus();
  const [line, setLine] = useState("Checking Host…");

  useEffect(() => {
    if (!connectionRef) {
      setLine("No ConnectionRef on this item.");
      return;
    }
    if (status.host !== "live") {
      setLine("Host disconnected — no receipt.");
      return;
    }
    let cancelled = false;
    void listConnections()
      .then(async (rows) => {
        const match = rows.find((row) => row.connectionRef === connectionRef);
        if (!match) {
          return "No Host connection for this ConnectionRef.";
        }
        const events = await connectionEvents(match.connectionId);
        const last = events[0];
        return last
          ? `${last.kind} · ${last.at}${last.detail ? ` · ${last.detail}` : ""}`
          : "No receipts yet.";
      })
      .then((next) => {
        if (!cancelled) setLine(next);
      })
      .catch(() => {
        if (!cancelled) setLine("Host disconnected — no receipt.");
      });
    return () => {
      cancelled = true;
    };
  }, [connectionRef, status.host]);

  return <p className="frow__notes">{line}</p>;
}
