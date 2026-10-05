/**
 * Sealing a new vault (ADR 0089), as a ceremony in a sheet. The one decision
 * that matters is how it opens — with this vault's key, or with a key of its
 * own — and the card's facts say what each buys before the name is sealed.
 */

import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconVault } from "../../components/Icons.js";

const OWN_KEY = "Its own key";
const SHARED_KEY = "This vault's key";

export function NewVaultSheet({
  canShareKey,
  busy,
  onSeal,
  onClose,
}: {
  /** A guest's key was never wrapped to disk, so there is nothing to share. */
  canShareKey: boolean;
  busy: boolean;
  onSeal: (name: string, shareKey: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [shareKey, setShareKey] = useState(canShareKey);
  const shared = shareKey && canShareKey;
  const ready = name.trim().length > 0;
  const seal = () => {
    if (ready) onSeal(name, shared);
  };

  return (
    <CeremonySheet
      title="Seal a new vault"
      mark={<IconVault size={20} />}
      onClose={onClose}
    >
      <form
        aria-label="Seal a new vault"
        onSubmit={(event) => {
          event.preventDefault();
          seal();
        }}
      >
        <CeremonyShell
          ok
          name="New vault"
          facts={[
            {
              key: "Opens",
              value: shared
                ? "with this vault's key, no extra prompt"
                : "with a passkey, PIN or password of its own",
            },
            {
              key: "Name",
              value: shared ? "listed with your vaults" : "sealed inside it",
            },
          ]}
          primary={{
            label: "Seal vault",
            submit: true,
            busy,
            disabled: !ready,
            onClick: seal,
          }}
        >
          <FieldShell
            id="vaults-new-name"
            label="Name"
            autoComplete="off"
            value={name}
            disabled={busy}
            onValueChange={setName}
          />
          {canShareKey ? (
            <div className="set__view" role="radiogroup" aria-label="Key">
              {[
                { id: true, label: SHARED_KEY },
                { id: false, label: OWN_KEY },
              ].map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  className="set__view-btn"
                  aria-pressed={shareKey === choice.id}
                  disabled={busy}
                  onClick={() => setShareKey(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
