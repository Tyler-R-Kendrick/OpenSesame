import { useEffect, useState } from "react";
import { createOpenSesame } from "@opensesame/sdk-browser";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

/**
 * Claim ownership review — distinct from device/CLI authorization.
 */
export function ClaimPage() {
  const [token, setToken] = useState<string | null>(null);
  const [claim, setClaim] = useState<{
    id: string;
    type: string;
    state: string;
    targetManifestDigest: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const t = params.get("token");
    if (t) {
      setToken(t);
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const sesame = createOpenSesame({ issuer });
    setLoading(true);
    setError(null);
    void sesame
      .presentClaim(token)
      .then((c) => {
        setClaim({
          id: c.id,
          type: c.type,
          state: c.state,
          targetManifestDigest: c.targetManifestDigest,
        });
      })
      .catch((e: unknown) => {
        setError(
          e instanceof Error
            ? e.message
            : "Could not load this claim. Check the token and try again.",
        );
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function complete() {
    if (!claim) return;
    const sesame = createOpenSesame({ issuer });
    setCompleting(true);
    setError(null);
    try {
      await sesame.completeClaim(claim.id, { acceptedItemIds: ["*"] });
      setDone(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Claim could not be completed. Try again.",
      );
    } finally {
      setCompleting(false);
    }
  }

  return (
    <section className="panel">
      <div className="badge">Claim ownership</div>
      <h1>Claim ownership of this agent/project/resources</h1>
      <p>
        This ceremony attaches durable ownership or delegation. It is not the
        same as authorizing a CLI session.
      </p>
      {!token ? (
        <>
          <label htmlFor="claim-token">Paste claim token</label>
          <input
            id="claim-token"
            placeholder="osc_clm_…"
            onChange={(e) => setToken(e.target.value.trim() || null)}
          />
        </>
      ) : null}
      {token && loading ? (
        <p className="lede" role="status" aria-busy="true">
          Loading claim details…
        </p>
      ) : null}
      {claim ? (
        <div>
          <p>
            Target type: <strong>{claim.type}</strong>
          </p>
          <p>
            Manifest digest: <code>{claim.targetManifestDigest}</code>
          </p>
          <p>State: {claim.state}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={done || completing}
              aria-busy={completing}
              onClick={() => void complete()}
            >
              {completing ? "Completing…" : "Complete claim"}
            </button>
          </div>
        </div>
      ) : null}
      {done ? (
        <p className="ok" role="status">
          Claim completed. Ownership is attached to your principal.
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
