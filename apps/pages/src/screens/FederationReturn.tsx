import { describeFederationError } from "@opensesame/app-core/lib/federation-copy.js";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { GateHelpSeat } from "../tutorial/gate-seat.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import "./broker.css";
import { runReturn } from "@opensesame/app-core/screens/federation-return-model.js";

export function FederationReturn() {
  useSupportRoute("/federation");
  // What the tour points at is the sentence the screen says, not the page.
  const statusRef = useGuideTarget<HTMLElement>("federation.return");
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
      <div className="broker">
        <FederationBar />
        <main className="broker__main">
          <div
            ref={statusRef}
            className="broker__card broker__card--err"
            role="alert"
          >
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
    <div className="broker">
      <FederationBar />
      <p ref={statusRef} className="broker__status">
        Finishing sign-in…
      </p>
    </div>
  );
}

/** The corner row: the seat the help key is drawn in (ADR 0166). */
function FederationBar() {
  return (
    <header className="broker__head">
      <div className="broker__bar">
        <GateHelpSeat />
      </div>
    </header>
  );
}

/** What a rejected ceremony hands the catch — an Error, or someone's throw. */
type BoundaryCatch = Error | string | undefined;
