import {
  type CardItem,
  type CertificateItem,
  type PasskeyItem,
  type SecretItem,
  isVaultCustodied,
} from "@opensesame/vault-core";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";

/** What a record's rows read: the item, and the reveal and copy ports. */
type RowProps<T> = {
  item: T;
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

export function PasskeyFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: RowProps<PasskeyItem>) {
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

export function CardFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: RowProps<CardItem>) {
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
}

export function SecretFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
  onUpdateSecret,
}: RowProps<SecretItem> & {
  onUpdateSecret: (next: string) => Promise<void>;
}) {
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
            itemId={item.id}
            label="secret"
            onUpdate={onUpdateSecret}
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
}

export function CertificateFields({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: RowProps<CertificateItem>) {
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
