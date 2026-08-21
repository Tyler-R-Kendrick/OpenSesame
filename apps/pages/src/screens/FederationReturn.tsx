/**
 * FederationReturn — finish upstream OIDC after redirect to the Pages root.
 * Must run without unlocking the vault (session is sessionStorage-only).
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FederationError, completeSignIn } from "../lib/federation.js";
import { ensureIdentitySession } from "../lib/identity.js";
import { joinOrgTenant } from "../lib/orgs.js";
import "./broker.css";

export function FederationReturn() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await completeSignIn();
        if (cancelled) return;
        if (result?.orgSlug && result.orgMethod) {
          await ensureIdentitySession();
          await joinOrgTenant(
            result.orgSlug,
            result.orgMethod,
            result.identity.idToken,
          );
        }
        if (cancelled) return;
        if (result?.returnTo) {
          navigate(result.returnTo, { replace: true });
          return;
        }
        navigate("/", { replace: true });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof FederationError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Sign-in failed.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="broker">
        <main className="broker__main">
          <div className="broker__card broker__card--err" role="alert">
            <h2>Sign-in failed</h2>
            <p>{error}</p>
            <button
              type="button"
              className="broker__btn"
              onClick={() => navigate("/", { replace: true })}
            >
              Back to OpenSesame
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="broker">
      <p className="broker__status">Finishing sign-in…</p>
    </div>
  );
}
