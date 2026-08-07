import { useState } from "react";
import { createOpenSesame } from "@opensesame/sdk-browser";
import { enqueue } from "../lib/queue.js";
import { loadSettings } from "../lib/settings.js";

export function ClaimPage({ online }: { online: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<{
    id: string;
    type: string;
    state: string;
  } | null>(null);

  async function present() {
    setError(null);
    setStatus(null);
    const t = token.trim();
    if (!t) {
      setError("Paste a claim token.");
      return;
    }
    if (!online) {
      enqueue({ kind: "claim_complete", claimToken: t });
      setStatus("Offline — claim queued for later completion.");
      return;
    }
    setBusy(true);
    try {
      const { identityApi } = loadSettings();
      const sesame = createOpenSesame({ issuer: identityApi });
      const c = await sesame.presentClaim(t);
      setClaim({ id: c.id, type: c.type, state: c.state });
      setStatus("Claim loaded. Review, then complete.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not present claim.");
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      const { identityApi } = loadSettings();
      const sesame = createOpenSesame({ issuer: identityApi });
      await sesame.completeClaim(claim.id, { acceptedItemIds: ["*"] });
      setStatus("Claim completed. Ownership is attached to your principal.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Complete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h1>Claim ownership</h1>
      <p>
        Attaches durable ownership or delegation. Distinct from Authorize CLI.
        Tokens are never forwarded downstream as SaaS credentials.
      </p>
      <label htmlFor="claim-token">Claim token</label>
      <input
        id="claim-token"
        placeholder="osc_clm_…"
        value={token}
        disabled={busy}
        onChange={(e) => setToken(e.target.value)}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void present()}
        >
          {busy ? "Working…" : online ? "Present claim" : "Queue claim"}
        </button>
        {claim ? (
          <button
            type="button"
            disabled={busy || !online}
            onClick={() => void complete()}
          >
            Complete claim
          </button>
        ) : null}
      </div>
      {claim ? (
        <ul className="status-list">
          <li>
            <span className="k">Type</span>
            <span className="v">{claim.type}</span>
          </li>
          <li>
            <span className="k">State</span>
            <span className="v">{claim.state}</span>
          </li>
          <li>
            <span className="k">Id</span>
            <span className="v">{claim.id}</span>
          </li>
        </ul>
      ) : null}
      {status ? (
        <p className="ok" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
