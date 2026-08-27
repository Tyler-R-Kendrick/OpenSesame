import { useEffect, useState } from "react";
import { readFragmentToken } from "../lib/deep-link.js";
import { gateway } from "../lib/issuer.js";

/**
 * Connection-delegation claim (ADR 0044) — a guest or agent accepts delegated
 * connector authority. The rules the backend enforces shape everything here:
 *
 * - The token leaves the URL before anything else happens (history and
 *   referrers never carry a bearer) and **presenting it spends it**: this
 *   page presents once, and a failure after that point keeps the manifest in
 *   memory rather than asking the server again — a second present burns the
 *   offer for everyone.
 * - The consent code travels out of band and is required to accept. Holding
 *   the link is not consent.
 * - Accepting names every accepted item; required items are pinned. There is
 *   no wildcard, because accepting something unseen is what the manifest
 *   review step exists to prevent.
 */

interface OfferItem {
  id: string;
  connection_id: string;
  provider_id: string;
  display_name: string;
  actions: string[];
  resources: string[];
  expires_in_seconds: number;
  execution_mode: "broker" | "relay";
  required: boolean;
  dependencies: string[];
}

interface Offer {
  id: string;
  state: string;
  manifest_digest: string;
  expires_at: string;
  items: OfferItem[];
}

interface Delegation {
  id: string;
  connection_id: string;
  execution_mode: "broker" | "relay";
  actions: string[];
  expires_at: string;
}

type Phase =
  | { kind: "token" }
  | { kind: "loading" }
  | { kind: "open"; token: string; offer: Offer }
  | { kind: "done"; delegations: Delegation[] };

function describeStatus(status: number, fallback: string): string {
  if (status === 404) {
    return "This delegation link is not valid. Ask the sender for a fresh one.";
  }
  if (status === 410) {
    return "This offer expired before it was accepted. Ask for a fresh one.";
  }
  if (status === 409) {
    return "This offer was already presented or has been burned. If you did not open it before, tell the sender: the link may have leaked, and everything minted from it has been revoked.";
  }
  if (status === 401) {
    return "Accepting needs a signed-in session with the Host API. Sign in, then reopen the link.";
  }
  return fallback;
}

interface PresentBody {
  claim_token: string;
}

interface ClaimBody {
  claim_token: string;
  user_code: string;
  accepted_item_ids: string[];
}

async function post(
  path: string,
  body: PresentBody | ClaimBody,
  session: string | null,
): Promise<Response> {
  return fetch(`${gateway}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session
        ? { authorization: `Bearer opaque-session:${session}` }
        : undefined),
    },
    body: JSON.stringify(body),
  });
}

export function DelegateClaim() {
  const [phase, setPhase] = useState<Phase>({ kind: "token" });
  const [tokenInput, setTokenInput] = useState("");
  const [userCode, setUserCode] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Fragment discipline first, presentation second: the bearer leaves the
    // URL before this page does anything else with it.
    const token = readFragmentToken(window.location.hash);
    if (token) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void present(token);
    }
    // present() is stable for the mount-time call; deps stay empty because
    // this must run exactly once — re-running would re-present a spent token.
  }, []);

  async function present(token: string) {
    setError(null);
    setPhase({ kind: "loading" });
    try {
      const res = await post(
        "/api/v1/delegations/present",
        {
          claim_token: token,
        },
        null,
      );
      if (!res.ok) {
        setError(describeStatus(res.status, "Presenting the offer failed."));
        setPhase({ kind: "token" });
        return;
      }
      // Rendering reads only fields the wire contract requires.
      // SAFETY: the gateway's DelegationOffer contract (api/openapi) fixes this shape.
      const { offer } = (await res.json()) as { offer: Offer };
      // Required items are the accepted baseline; optional ones start
      // unchecked so accepting them is a decision, not a default.
      setAccepted(
        new Set(
          offer.items.filter((item) => item.required).map((item) => item.id),
        ),
      );
      setPhase({ kind: "open", token, offer });
    } catch {
      setError("The Host API is not reachable from here.");
      setPhase({ kind: "token" });
    }
  }

  async function connectSession(): Promise<string | null> {
    // Dev-grade session mint; production deployments sign in through the
    // Identity device flow and the gateway refuses this route outright.
    try {
      const res = await fetch(`${gateway}/api/v1/session/local`, {
        method: "POST",
      });
      if (!res.ok) return null;
      // An absent field falls through to the null branch below.
      // SAFETY: the local session mint returns { session_id } by contract.
      const body = (await res.json()) as { session_id?: string };
      return body.session_id ?? null;
    } catch {
      return null;
    }
  }

  function toggle(offer: Offer, id: string) {
    const item = offer.items.find((candidate) => candidate.id === id);
    if (!item || item.required) return;
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        // Dropping an item drops everything that depends on it — the server
        // would refuse a dependency-open set, so the page never offers one.
        for (const other of offer.items) {
          if (other.dependencies.includes(id)) next.delete(other.id);
        }
      } else {
        next.add(id);
        for (const dep of item.dependencies) next.add(dep);
      }
      return next;
    });
  }

  async function accept(token: string, offer: Offer) {
    setError(null);
    const code = userCode.trim();
    if (!code) {
      setError(
        "Enter the consent code the sender read out. It travels separately from the link on purpose: holding the link is not consent.",
      );
      return;
    }
    setBusy(true);
    try {
      let live = session;
      if (!live) {
        live = await connectSession();
        if (!live) {
          setError(describeStatus(401, ""));
          setBusy(false);
          return;
        }
        setSession(live);
      }
      const res = await post(
        "/api/v1/delegations/claim",
        {
          claim_token: token,
          user_code: code,
          accepted_item_ids: [...accepted],
        },
        live,
      );
      if (!res.ok) {
        setError(
          describeStatus(
            res.status,
            "Accepting failed. Check the consent code and try again.",
          ),
        );
        setBusy(false);
        return;
      }
      // Only contract-required fields are rendered.
      // SAFETY: the gateway's Delegation contract (api/openapi) fixes this shape.
      const { delegations } = (await res.json()) as {
        delegations: Delegation[];
      };
      setPhase({ kind: "done", delegations });
    } catch {
      setError("The Host API is not reachable from here.");
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === "done") {
    return (
      <section className="panel">
        <div className="badge">Access accepted</div>
        <h1>Delegated access is active</h1>
        <p className="lede">
          You can now use{" "}
          {phase.delegations.length === 1
            ? "this connection"
            : "these connections"}{" "}
          through OpenSesame. The owner sees every use and can revoke at any
          time; the credentials themselves never moved.
        </p>
        <ul className="items">
          {phase.delegations.map((delegation) => (
            <li key={delegation.id}>
              <strong>{delegation.connection_id}</strong>
              <span className="hint">
                {delegation.actions.join(", ")} · until{" "}
                {new Date(delegation.expires_at).toLocaleString()}
                {delegation.execution_mode === "relay"
                  ? " · runs on the owner's device"
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (phase.kind === "open") {
    const { offer, token } = phase;
    return (
      <section className="panel">
        <div className="badge">Review delegated access</div>
        <h1>Someone is sharing connector access with you</h1>
        <p className="lede">
          Review exactly what is offered before accepting. Credentials never
          change hands — you get bounded access through OpenSesame, and the
          owner can revoke it at any time.
        </p>
        <ul className="items">
          {offer.items.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={accepted.has(item.id)}
                  disabled={item.required || busy}
                  onChange={() => toggle(offer, item.id)}
                />{" "}
                <strong>{item.display_name}</strong> ({item.provider_id})
                {item.required ? <em> — required</em> : null}
              </label>
              <span className="hint">
                {item.actions.join(", ")} · {item.resources.join(", ")} ·{" "}
                {Math.round(item.expires_in_seconds / 60)} min
                {item.execution_mode === "relay"
                  ? " · each use runs on the owner's device and may wait for their approval"
                  : ""}
              </span>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void accept(token, offer);
          }}
        >
          <label htmlFor="delegate-user-code">Consent code</label>
          <input
            id="delegate-user-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="WORD-WORD"
            value={userCode}
            disabled={busy}
            onChange={(event) => setUserCode(event.target.value)}
          />
          <p className="hint">
            Read out by whoever sent this link. It travels separately on
            purpose: the link alone is not consent.
          </p>
          {error ? (
            <output className="err" role="alert">
              {error}
            </output>
          ) : null}
          <button type="submit" disabled={busy || accepted.size === 0}>
            Accept selected access
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="badge">Accept delegated access</div>
      <h1>Accept delegated connector access</h1>
      <p className="lede">
        Someone wants to share access to a connection (or a set of them) with
        you — without ever handing over their credentials. Links shared with you
        open here as <code>/delegate#token=osc_dlg_…</code>.
      </p>
      {phase.kind === "loading" ? (
        <output className="lede">Opening the offer…</output>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = tokenInput.trim();
            if (trimmed) void present(trimmed);
          }}
        >
          <label htmlFor="delegate-token">Delegation link token</label>
          <input
            id="delegate-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="osc_dlg_…"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
          />
          <p className="hint">
            Opening the offer spends its single presentation — this page asks
            the sender's Host API to show you the manifest exactly once.
          </p>
          {error ? (
            <output className="err" role="alert">
              {error}
            </output>
          ) : null}
          <button type="submit" disabled={tokenInput.trim().length === 0}>
            Open offer
          </button>
        </form>
      )}
    </section>
  );
}
