import { forgetVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect-session.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconTrash } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { ConnectTransportForm } from "./ConnectTransportForm.js";

/** The one key that forgets the held Connect credential, memory and vault. */
function ForgetConnectKey({
  tomb,
  onFlash,
  onForgotten,
}: {
  tomb: string | undefined;
  onFlash: (flash: Flash) => void;
  onForgotten: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function forget() {
    setBusy(true);
    try {
      await forgetVercelConnectAuth(tomb || null);
      onForgotten();
      onFlash({
        tone: "ok",
        text: "Vercel Connect is forgotten on this device.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label="Forget Vercel Connect"
      title="Forget Vercel Connect"
      disabled={busy}
      onClick={() => void forget()}
    >
      <IconTrash size={15} />
    </button>
  );
}

/**
 * Where connectors live: the Vercel Connect credential (see
 * `ConnectTransportForm`). Once one is held, the head carries the one key
 * that forgets it: out of memory and out of the vault. With the form
 * satisfied the panel is only that key.
 */
export function ConnectTransportPanel({
  relay,
  showForm,
  held,
  onFlash,
}: {
  relay: boolean;
  /** False once this session can already manage connectors. */
  showForm: boolean;
  /** This session holds a Connect credential to forget. */
  held: boolean;
  onFlash: (flash: Flash) => void;
}) {
  const { tomb } = useVault();
  // A forget re-mounts the form, so it asks for team and project afresh.
  const [generation, setGeneration] = useState(0);
  return (
    <section
      className="panel"
      id="connect-transport"
      aria-label="Vercel Connect"
    >
      <div className="panel__head">
        <h2>Vercel Connect</h2>
        {held ? (
          <ForgetConnectKey
            tomb={tomb}
            onFlash={onFlash}
            onForgotten={() => setGeneration((value) => value + 1)}
          />
        ) : null}
      </div>
      {showForm ? (
        <ConnectTransportForm
          key={generation}
          relay={relay}
          onFlash={onFlash}
        />
      ) : null}
    </section>
  );
}
