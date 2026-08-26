/**
 * FederationReturn — finish upstream OIDC after redirect to the Pages root.
 * Must run without unlocking the vault (session is sessionStorage-only).
 *
 * Whatever happens here is said out loud: success and pending-link outcomes
 * are stored for the unlock screen's banner (the notifications bell only
 * exists after unlock), and failures render in plain words with a way back —
 * never a silent bounce to the start.
 *
 * The ceremony is single-flight ON PURPOSE. `completeSignIn` spends one-shot
 * state synchronously (the PKCE record, the code in the address bar), so a
 * second concurrent run sees "no sign-in in progress" and would navigate home
 * while the first — StrictMode's remounted twin, whose `cancelled` guard has
 * already tripped — finishes the exchange and then drops the identity on the
 * floor. That was the literal "the Google button just fails" bug in every
 * dev build. One shared promise means the work happens exactly once and
 * whichever mounted instance survives applies its outcome.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { storeAuthOutcome } from "../lib/auth-outcome.js";
import { describeFederationError } from "../lib/federation-copy.js";
import {
  adoptBrokeredSession,
  completeSignIn,
  displayName,
} from "../lib/federation.js";
import { adoptFederatedIdentity } from "../lib/guest-auth.js";
import { ensureIdentitySession } from "../lib/identity.js";
import { joinOrgTenant } from "../lib/orgs.js";
import "./broker.css";

type ReturnOutcome = { returnTo?: string };

async function processReturn(): Promise<ReturnOutcome> {
  const result = await completeSignIn();
  if (!result) return {};
  if (result.orgSlug && result.orgMethod) {
    await ensureIdentitySession();
    await joinOrgTenant(
      result.orgSlug,
      result.orgMethod,
      result.identity.idToken,
    );
    storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
  } else if (result.accessToken) {
    // Brokered sign-in (D8): the Identity API already decided which principal
    // this is when it issued the token, so the access token is traded for a
    // session bound to THAT principal. The id_token beside it is pairwise for
    // this origin and is deliberately never linked — doing so would attach it
    // to whichever session this tab holds (T23).
    await adoptBrokeredSession(result.accessToken);
    storeAuthOutcome({ kind: "linked", who: displayName(result.identity) });
  } else if (result.identity?.idToken) {
    // Attach the identity in whatever state this device is in: a true first
    // run opens a guest vault first, a locked vault defers to a notice rather
    // than binding the identity to a throwaway principal.
    const adopted = await adoptFederatedIdentity(result.identity.idToken);
    storeAuthOutcome(
      adopted.kind === "linked"
        ? { kind: "linked", who: displayName(result.identity) }
        : adopted.kind === "pending_link"
          ? { kind: "pending_link", who: displayName(result.identity) }
          : {
              kind: "link_failed",
              detail: adopted.reason,
              who: displayName(result.identity),
            },
    );
  }
  return result.returnTo !== undefined ? { returnTo: result.returnTo } : {};
}

let inFlightReturn: Promise<ReturnOutcome> | null = null;

/** Test hook: drop a ceremony a previous test left unsettled. */
export function resetFederationReturnCeremony(): void {
  inFlightReturn = null;
}

/** The one shared ceremony; cleared once settled so a later sign-in reruns. */
function runReturn(): Promise<ReturnOutcome> {
  if (!inFlightReturn) {
    inFlightReturn = processReturn().finally(() => {
      inFlightReturn = null;
    });
  }
  return inFlightReturn;
}

export function FederationReturn() {
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
    <div className="broker">
      <p className="broker__status">Finishing sign-in…</p>
    </div>
  );
}

/** What a rejected ceremony hands the catch — an Error, or someone's throw. */
type BoundaryCatch = Error | string | undefined;
