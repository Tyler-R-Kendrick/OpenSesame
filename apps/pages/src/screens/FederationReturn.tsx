import { describeFederationError } from "@opensesame/app-core/lib/federation-copy.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import "./broker.css";
import { runReturn } from "@opensesame/app-core/screens/federation-return-model.js";

export function FederationReturn() {
  useSupportRoute("/federation");
  const rootRef = useGuideTarget<HTMLDivElement>("federation.return");
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    runReturn()
      .then((outcome) => {
        if (cancelled) return;
        navigate(outcome.returnTo ?? "/", { replace: true });
      })
      .catch((err: BoundaryCatch) => {
        if (cancelled) return;
        setError(describeFederationError(err instanceof Error ? err : ""));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (error) {
    return (
      <div ref={rootRef} className="broker">
        <main className="broker__main">
          <div className="broker__card broker__card--err" role="alert">
            <h2>Sign-in didn't finish</h2>
            <p>{error}</p>
            <button
              type="button"
              className="broker__btn"
              onClick={() => navigate("/", { replace: true })}
            >
              Back to sign-in
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="broker">
      <p className="broker__status">Finishing sign-in…</p>
    </div>
  );
}

/** What a rejected ceremony hands the catch — an Error, or someone's throw. */
type BoundaryCatch = Error | string | undefined;
