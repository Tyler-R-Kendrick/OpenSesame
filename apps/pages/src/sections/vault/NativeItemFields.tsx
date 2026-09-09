import { overlapCast } from "@opensesame/os-domain";
import type { VaultItem } from "../../lib/vault/model.js";
import { OptionalField } from "./EditorExtras.js";

type Props = {
  draft: VaultItem;
  onChange: (changes: Partial<VaultItem>) => void;
};

function PasskeyFields({ draft, onChange: patch }: Props) {
  if (draft.kind !== "passkey") return null;
  return (
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
          <option value="cross-platform">Security key or another device</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="credid">Credential id</label>
        <input
          id="credid"
          spellCheck={false}
          value={draft.credentialIdB64}
          onChange={(event) => patch({ credentialIdB64: event.target.value })}
        />
      </div>
      <p className="note">
        <span>
          This records a credential; it does not create one. The private key
          stays in the authenticator and never enters the vault.
        </span>
      </p>
    </div>
  );
}

function CardFields({ draft, onChange: patch }: Props) {
  if (draft.kind !== "card") return null;
  return (
    <div className="editor__grid">
      <div className="editor__row">
        <div className="field">
          <label htmlFor="cardholder">Cardholder</label>
          <input
            id="cardholder"
            autoComplete="off"
            value={draft.cardholder}
            onChange={(event) => patch({ cardholder: event.target.value })}
          />
        </div>
        <OptionalField present={Boolean(draft.brand)} command="Add brand">
          <div className="field">
            <label htmlFor="brand">Brand</label>
            <input
              id="brand"
              autoComplete="off"
              value={draft.brand}
              onChange={(event) => patch({ brand: event.target.value })}
            />
          </div>
        </OptionalField>
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
              onChange={(event) => patch({ expMonth: event.target.value })}
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
        <OptionalField
          present={Boolean(draft.code)}
          command="Add security code"
        >
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
        </OptionalField>
      </div>
    </div>
  );
}

function CertificateFields({ draft, onChange: patch }: Props) {
  if (draft.kind !== "certificate") return null;
  return (
    <div className="editor__grid">
      <div className="field">
        <label htmlFor="cert-cn">Common name</label>
        <input
          id="cert-cn"
          value={draft.commonName}
          readOnly={Boolean(draft.certificatePem)}
          onChange={(event) => patch({ commonName: event.target.value })}
        />
      </div>
      <OptionalField present={Boolean(draft.dnsNames)} command="Add DNS names">
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
      </OptionalField>
      <div className="editor__row">
        <OptionalField
          present={Boolean(draft.ipAddrs)}
          command="Add IP addresses"
        >
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
        </OptionalField>
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
  );
}

export function NativeItemFields(props: Props) {
  return (
    <>
      <PasskeyFields {...props} />
      <CardFields {...props} />
      <CertificateFields {...props} />
    </>
  );
}
