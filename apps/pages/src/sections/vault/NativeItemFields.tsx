import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { overlapCast } from "@opensesame/os-domain";
import {
  type CardItem,
  type VaultItem,
  cardDigits,
  detectCardBrand,
  formatCardNumber,
} from "@opensesame/vault-core";
import { useRef } from "react";
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
            maxLength={FIELD_LIMITS.line}
            placeholder="example.com"
            value={draft.rpId}
            onChange={(event) => patch({ rpId: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pk-user">Account</label>
          <input
            id="pk-user"
            maxLength={FIELD_LIMITS.line}
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
          maxLength={FIELD_LIMITS.list}
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

function CardFields({ draft, onChange }: Props) {
  if (draft.kind !== "card") return null;
  return <CardEditor draft={draft} onPatch={onChange} />;
}

function CardEditor({
  draft,
  onPatch,
}: {
  draft: CardItem;
  onPatch: (changes: Partial<VaultItem>) => void;
}) {
  const initialDetected = detectCardBrand(draft.number);
  const manualBrand = useRef(
    Boolean(draft.brand.trim()) && draft.brand !== initialDetected?.name,
  );
  const detected = detectCardBrand(draft.number);
  const brandHint = detected
    ? `Detected from the number: ${detected.name}.`
    : draft.number.length >= 12 && !manualBrand.current
      ? "Card type not recognized. Enter the brand manually."
      : "";

  function changeNumber(value: string): void {
    const digits = cardDigits(value);
    const next = detectCardBrand(digits);
    onPatch({
      number: digits,
      brand: manualBrand.current ? draft.brand : (next?.name ?? ""),
    });
  }

  return (
    <div className="editor__grid">
      <div className="editor__row">
        <div className="field">
          <label htmlFor="cardholder">Cardholder</label>
          <input
            id="cardholder"
            autoComplete="off"
            maxLength={FIELD_LIMITS.line}
            value={draft.cardholder}
            onChange={(event) => onPatch({ cardholder: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="brand">Brand</label>
          <input
            id="brand"
            autoComplete="off"
            maxLength={FIELD_LIMITS.label}
            placeholder="Detected from the number"
            value={draft.brand}
            onChange={(event) => {
              const brand = event.target.value;
              manualBrand.current = brand.trim().length > 0;
              onPatch({ brand });
            }}
          />
        </div>
      </div>
      {brandHint ? <p className="hint">{brandHint}</p> : null}
      <div className="field">
        <label htmlFor="number">Number</label>
        <input
          id="number"
          inputMode="numeric"
          autoComplete="off"
          value={formatCardNumber(draft.number, draft.brand)}
          onChange={(event) => changeNumber(event.target.value)}
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
                onPatch({ expMonth: event.target.value.replace(/\D/g, "") })
              }
            />
            <input
              inputMode="numeric"
              placeholder="YYYY"
              maxLength={4}
              aria-label="Expiry year"
              value={draft.expYear}
              onChange={(event) =>
                onPatch({ expYear: event.target.value.replace(/\D/g, "") })
              }
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cvc">Security code (optional)</label>
          <input
            id="cvc"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            placeholder="CVV"
            value={draft.code}
            onChange={(event) =>
              onPatch({ code: event.target.value.replace(/\D/g, "") })
            }
          />
        </div>
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
          maxLength={FIELD_LIMITS.line}
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
            maxLength={FIELD_LIMITS.list}
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
              maxLength={FIELD_LIMITS.list}
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
            maxLength={FIELD_LIMITS.hours}
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
