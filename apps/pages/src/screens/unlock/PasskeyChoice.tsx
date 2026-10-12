import type { PasskeyAttachment } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-ceremony.js";
import { PasskeyHostNote } from "./PasskeyHostNote.js";

type Host = Readonly<{
  ok: boolean;
  reason?: string | undefined;
  fixUrl?: string | null | undefined;
}>;

/** Where a new passkey may live; named so the browser cannot pick Windows Hello for a key. */
export const PASSKEY_KINDS = [
  { id: "platform", label: "This device" },
  { id: "cross-platform", label: "Security key" },
] as const satisfies ReadonlyArray<{ id: PasskeyAttachment; label: string }>;

/**
 * Under the Passkey tab: why this origin cannot run a ceremony, or — while a
 * new vault is being sealed — which kind of authenticator holds the key. Left
 * to the browser, a PC with Windows Hello offers that first, and a Hello that
 * cannot answer PRF never reaches a YubiKey plugged in beside it.
 */
export function PasskeyChoice({
  host,
  seals,
  value,
  onPick,
}: {
  host: Host;
  /** A first-run seal is being made on the Passkey tab. */
  seals: boolean;
  value: PasskeyAttachment;
  onPick: (kind: PasskeyAttachment) => void;
}) {
  if (!host.ok) return <PasskeyHostNote host={host} />;
  if (!seals) return null;
  return (
    <div className="unlock__methods" role="tablist" aria-label="Passkey on">
      {PASSKEY_KINDS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className={
            value === id
              ? "unlock__method unlock__method--active"
              : "unlock__method"
          }
          // Not gated on `busy`: choosing the other kind is how a person leaves
          // a prompt that will never answer, as the method tabs are.
          onClick={() => onPick(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
