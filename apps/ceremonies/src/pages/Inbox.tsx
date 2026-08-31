import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  type ApprovalDecision,
  ApprovalError,
  type AuthorizationRequestView,
  assuranceSummary,
  describeDetail,
  listPending,
  needsCeremony,
  settle,
} from "../lib/approvals.js";

/**
 * The authorization-request inbox (ADR 0046).
 *
 * Requests wait here for the person whose authority they need. The page shows
 * the binding message — the same short string the requester sees, so "is this
 * the thing I just started?" has an answer — and renders the
 * `authorization_details` as what would actually happen, rather than a scope
 * string nobody can evaluate.
 *
 * Deciding echoes the request digest back. If what is stored has changed since
 * this list was drawn, the server refuses rather than accepting consent for
 * something the person did not read.
 *
 * A row that needs more than a decision — a transaction-bound passkey touch, a
 * comparison code — is deliberately *not* decidable from here (ADR 0084).
 * There is no honest way to run those ceremonies inside a list, so the row
 * links to the review page instead and says what will be asked for. An inline
 * "Approve" that quietly did less than the policy demands would be the worst
 * of both: a person believing they had approved, and a server that refused.
 */

export function Inbox() {
  const [items, setItems] = useState<AuthorizationRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listPending());
      setSignedIn(true);
    } catch (e) {
      setItems([]);
      if (e instanceof ApprovalError && e.code === "signin") setSignedIn(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(
    item: AuthorizationRequestView,
    decision: ApprovalDecision,
  ) {
    setBusyId(item.authReqId);
    setError(null);
    try {
      // The digest travels back exactly as it was shown. A request that changed
      // in between is refused rather than silently consented to.
      await settle(item.authReqId, decision, {
        requestDigest: item.requestDigest,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="inbox-title">
      <div className="badge">Requests for you</div>
      <h1 id="inbox-title">Approve or deny access requests</h1>
      <p>
        Someone — a person or an agent — is asking to use authority that is
        yours. Read what each one would actually do before allowing it.
      </p>

      {items === null ? (
        <output className="lede" aria-busy="true">
          Loading requests…
        </output>
      ) : null}

      {items?.length === 0 && !error ? (
        <output className="lede">Nothing is waiting for you right now.</output>
      ) : null}

      {items?.map((item) => (
        <div className="panel" key={item.authReqId}>
          <p>
            <strong>{item.bindingMessage}</strong>
          </p>
          <ul className="index">
            {item.authorizationDetails.map((detail) => (
              <li
                key={`${item.authReqId}-${detail.type}-${describeDetail(detail)}`}
              >
                {describeDetail(detail)}
              </li>
            ))}
          </ul>
          <p className="fine">
            Expires {new Date(item.expiresAt).toLocaleString()} · request{" "}
            <code>{item.requestDigest.slice(0, 12)}…</code>
          </p>
          <p className="fine">{assuranceSummary(item)}</p>
          {needsCeremony(item) ? (
            <div className="actions">
              <Link
                className="button"
                to={`/approve/${encodeURIComponent(item.authReqId)}`}
              >
                Review
              </Link>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busyId === item.authReqId}
                aria-busy={busyId === item.authReqId}
                onClick={() => void decide(item, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busyId === item.authReqId}
                onClick={() => void decide(item, "deny")}
              >
                Deny
              </button>
            </div>
          )}
        </div>
      ))}

      {!signedIn ? (
        <p className="fine">
          These are requests for a specific account, so this page needs you
          signed in — a guest session has no authority for anyone to ask for.
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
