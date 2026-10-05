import {
  type VaultItem,
  definitionFor,
  hostOf,
  isVaultCustodied,
  itemTypeId,
  totpSetupUri,
  typeLabel,
} from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import {
  IconCheck,
  IconChevronLeft,
  IconCopy,
  IconExternal,
  IconEye,
  IconEyeOff,
} from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { StatusMark } from "../../components/StatusMark.js";
import { TotpCode, currentTotp } from "../../components/TotpCode.js";
import { UpLink } from "../../components/UpLink.js";
import { useVaultList } from "../../lib/vault-list-path.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ItemGone } from "./ItemGone.js";
import { ItemTools } from "./ItemTools.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { StrengthBar } from "./StrengthBar.js";
import { TypedFieldRows, UnknownTypeRows } from "./TypedFields.js";
import { KindRecord, SecretShares } from "./item-contributions.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ItemDetail() {
  const { itemId } = useParams();
  const location = useLocation();
  const { listPath, backLabel } = useVaultList(location.search);
  const { items, folders } = useVault();
  const store = useVaultStore();
  const { copied, failed, copy } = useCopyFeedback();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirmPurge, setConfirmPurge] = useState(false);

  const item = items.find((candidate) => candidate.id === itemId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemId is the trigger, not an input — a revealed secret must not survive a move to another item
  useEffect(() => {
    setRevealed(new Set());
    setConfirmPurge(false);
  }, [itemId]);

  if (!item) return <ItemGone listPath={listPath} />;

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
      <div className="detail__head">
        <UpLink
          pane="list"
          data-pane-close=""
          className="icon-btn detail__backbtn"
          aria-label={backLabel}
          title={backLabel}
          to={listPath}
        >
          <IconChevronLeft size={17} />
        </UpLink>
        <div className="detail__heading">
          <h1>{item.name || "Untitled"}</h1>
          <div className="detail__meta">
            <span>{typeLabel(itemTypeId(item))}</span>
            {folder ? (
              <Link to={`/vault?folder=${encodeURIComponent(folder.id)}`}>
                {folder.name}
              </Link>
            ) : null}
            <span>Updated {formatDate(item.updatedAt)}</span>
            {inTrash ? <StatusMark tone="warn" label="In trash" /> : null}
          </div>
        </div>
        <ItemTools
          item={item}
          listPath={listPath}
          confirmPurge={confirmPurge}
          onConfirmPurge={setConfirmPurge}
        />
      </div>

      <ItemFields
        item={item}
        revealed={revealed}
        toggle={toggle}
        copied={copied}
        failed={failed}
        copy={copy}
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
      {item.kind !== "drop" ? (
        <SecretShares
          item={item}
          initialOpen={
            new URLSearchParams(location.search).get("share") === "drop"
          }
        />
      ) : null}

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

      {confirmPurge ? (
        <p className="visually-hidden" role="alert">
          Purging deletes the encrypted record permanently. Press the trash key
          again to confirm — this cannot be undone.
        </p>
      ) : null}
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
  onUpdateSecret: (next: string) => Promise<void>;
};

function ItemFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
  onUpdateSecret,
}: FieldsProps) {
  const update = { itemId: item.id, onUpdate: onUpdateSecret };
  const usernameRef = useGuideTarget<HTMLButtonElement>("item.copy-username");
  const passwordRef = useGuideTarget<HTMLButtonElement>("item.copy-password");
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
                    guideRef={usernameRef}
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
                      guideRef={passwordRef}
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
                <UpdateSecretPanel {...update} label="password" />
              </FieldRow>
            ) : (
              <UpdateSecretPanel {...update} label="password" />
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
                      className={`icon-btn${revealed.has("totp-qr") ? " is-on" : ""}`}
                      onClick={() => toggle("totp-qr")}
                      aria-label={
                        revealed.has("totp-qr")
                          ? "Hide setup QR"
                          : "Show setup QR"
                      }
                      title={
                        revealed.has("totp-qr")
                          ? "Hide setup QR"
                          : "Show setup QR"
                      }
                    >
                      {revealed.has("totp-qr") ? (
                        <IconEyeOff size={17} />
                      ) : (
                        <IconEye size={17} />
                      )}
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
                const href = loginWebsiteLink(uri);
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
            <h2 className="detail__grouphead">Value</h2>
            <div className="secret-value">
              <div className="frow__text">
                <ConcealedValue
                  value={item.value}
                  label="secret value"
                  revealed={revealed.has("value")}
                />
              </div>
              <UpdateSecretPanel
                {...update}
                label="secret"
                leading={
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
              />
            </div>
          </section>
          <section className="detail__group">
            <h2 className="detail__grouphead">Grantees</h2>
            <div className="frow">
              <span className="frow__value">
                {item.grantees.length > 0 ? item.grantees.join(", ") : "None"}
              </span>
            </div>
          </section>
        </>
      );

    case "drop":
      return <KindRecord item={item} />;

    case "note":
      return (
        <section className="detail__group">
          <h2 className="detail__grouphead">Note</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes || "This note is empty."}</p>
          </div>
        </section>
      );

    case "typed": {
      const definition = definitionFor(item);
      if (definition === undefined) {
        return (
          <UnknownTypeRows
            typeId={item.typeId}
            values={item.values}
            revealed={revealed}
            toggle={toggle}
          />
        );
      }
      return (
        <TypedFieldRows
          definition={definition}
          values={item.values}
          revealed={revealed}
          toggle={toggle}
          copied={copied}
          failed={failed}
          copy={copy}
        />
      );
    }

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
          </section>
        </>
      );
  }
}

import { loginWebsiteLink } from "@opensesame/app-core/lib/vault/website-pattern.js";
