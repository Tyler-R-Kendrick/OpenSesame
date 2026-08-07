import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { IconVault } from "../components/Icons.js";
import {
  hasUnlockPin,
  setUnlockPin,
  unlock,
} from "../lib/lock.js";

export function UnlockPage() {
  const navigate = useNavigate();
  const firstRun = !hasUnlockPin();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (firstRun) {
        if (pin !== confirm) {
          throw new Error("PIN and confirmation do not match.");
        }
        await setUnlockPin(pin);
      } else {
        await unlock(pin);
      }
      navigate("/vault", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={(e) => void onSubmit(e)}>
        <div className="unlock-brand">
          <span className="vault-mark large" aria-hidden="true" />
          <h1>OpenSesame</h1>
          <p>Authority vault for humans and agents</p>
        </div>

        <p className="unlock-honest">
          Session unlock only (PIN ≥ 6 chars, salted PBKDF2). Sealed OPFS blobs
          stay ciphertext — this PIN never decrypts secrets into the page.
        </p>

        <label htmlFor="unlock-pin">
          {firstRun ? "Create unlock PIN" : "Unlock PIN"}
        </label>
        <input
          id="unlock-pin"
          type="password"
          autoComplete={firstRun ? "new-password" : "current-password"}
          autoFocus
          value={pin}
          disabled={busy}
          onChange={(e) => setPin(e.target.value)}
        />

        {firstRun ? (
          <>
            <label htmlFor="unlock-confirm">Confirm PIN</label>
            <input
              id="unlock-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={busy}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        ) : null}

        <button type="submit" className="primary unlock-submit" disabled={busy}>
          <IconVault />
          {busy ? "Working…" : firstRun ? "Create vault unlock" : "Unlock vault"}
        </button>

        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
