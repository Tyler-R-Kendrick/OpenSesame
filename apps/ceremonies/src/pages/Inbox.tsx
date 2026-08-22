import { overlapCast } from "@opensesame/os-domain";
import { createOpenSesame } from "@opensesame/sdk-browser";
import { useCallback, useEffect, useState } from "react";
import { issuer } from "../lib/issuer.js";

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
 */

interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  identifier?: string;
}

interface InboxItem {
  authReqId: string;
  status: string;
  bindingMessage: string;
  requestDigest: string;
  authorizationDetails: AuthorizationDetail[];
  expiresAt: string;
  connectionId?: string;
  decidedByKind?: string;
}

function describeDetail(detail: AuthorizationDetail): string {
  const actions = detail.actions?.length ? detail.actions.join(", ") : "use";
  const where = detail.locations?.length
    ? detail.locations.join(", ")
    : (detail.identifier ?? detail.type);
  return `${actions} — ${where}`;
}

export function Inbox() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(true);

  const base = issuer.replace(/\/$/, "");

  const authorized = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const session = await createOpenSesame({ issuer }).getSession();
      if (!session) {
        setSignedIn(false);
        throw new Error("Sign in to see requests waiting for you.");
      }
      setSignedIn(true);
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
      });
    },
    [base],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await authorized("/v1/authorization-requests?status=pending");
      if (!res.ok) throw new Error(`Could not load the inbox (${res.status}).`);
      const body: { requests: InboxItem[] } = overlapCast(await res.json());
      setItems(body.requests);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authorized]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: InboxItem, decision: "approve" | "deny") {
    setBusyId(item.authReqId);
    setError(null);
    try {
      // The digest travels back exactly as it was shown. A request that changed
      // in between is refused rather than silently consented to.
      const res = await authorized(
        `/v1/authorization-requests/${encodeURIComponent(item.authReqId)}/${decision}`,
        {
          method: "POST",
          body: JSON.stringify({ requestDigest: item.requestDigest }),
        },
      );
      if (res.status === 409) {
        throw new Error(
          "This request changed since it was shown, so nothing was decided. Reload and read it again.",
        );
      }
      if (res.status === 410) {
        throw new Error("This request expired before it was decided.");
      }
      if (!res.ok) throw new Error(`That did not go through (${res.status}).`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel">
      <div className="badge">Requests for you</div>
      <h1>Approve or deny access requests</h1>
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
