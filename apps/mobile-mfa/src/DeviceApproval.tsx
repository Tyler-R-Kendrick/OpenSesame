import { CeremonyRequestError, approveDevice } from "@opensesame/ceremony-kit";
import { useCallback, useState } from "react";
import { type Notice, Status } from "./Status.js";
import { TokenField } from "./TokenField.js";
import { identityBase } from "./identity.js";

/**
 * Device-authorization approval, for the links that predate ADR 0086.
 *
 * The call, the body and the status-to-copy mapping are
 * `@opensesame/ceremony-kit`'s. This app used to carry its own copy that hit
 * the same URL with a weaker mapping — no 404 branch, one sentence covering
 * both 401 and 403 — plus a `principal` field the Identity API documents as
 * ignored (`apps/control-plane/src/openapi.ts`). A field the server discards is
 * worse than no field: it tells the person filling it in that it decides
 * something.
 *
 * Approving here grants a short-lived client session and transfers ownership of
 * nothing. ADR 0009 keeps device authorization and ownership claims apart, and
 * a `claim_id` riding along on a link does not get to blur that: it is shown as
 * a dead end and sends the human somewhere else.
 */

export interface DeviceApprovalProps {
  /** Prefilled from a legacy link; typed by hand on the standalone surface. */
  initialUserCode?: string;
  /** A claim id the link carried. Shown as a dead end, never acted on. */
  claimId?: string;
  token: string;
  onTokenChange: (next: string) => void;
  /**
   * Whether this panel owns the page's single bearer field. Exactly one
   * component may, or the field's id stops being unique and its label stops
   * pointing anywhere.
   */
  ownsTokenField: boolean;
  /** Rendered as the page's own question rather than as one card among many. */
  lead: boolean;
}

/**
 * A fetch that carries this app's pasted bearer.
 *
 * The kit takes the surface's own fetch precisely so each one can attach what
 * authenticates it: the console has a session cookie and nothing else, Pages
 * has a vault-held bearer, and this phone has whatever was pasted into the
 * token field. `credentials: "include"` still rides along from the kit's
 * default, so a cookie-authenticated session keeps working when no token is.
 */
function withBearer(token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    // Only when there is one. An empty `Bearer ` header is a malformed
    // credential, and a server that rejects it would mask the cookie that
    // would otherwise have authenticated the call.
    if (token.length > 0) headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

export function DeviceApproval({
  initialUserCode,
  claimId,
  token,
  onTokenChange,
  ownsTokenField,
  lead,
}: DeviceApprovalProps) {
  const [userCode, setUserCode] = useState(initialUserCode ?? "");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Attached only to the `lead` heading: moving focus into a card the human
  // did not open is a jump, not an affordance.
  const focusOnMount = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus();
  }, []);

  async function approve() {
    // No local empty-code guard. `approveDevice` already refuses a blank code
    // before it reaches the network, with wording the kit owns; a second guard
    // here would be a second sentence for one rule, and the two would drift.
    setNotice(null);
    setBusy(true);
    try {
      await approveDevice({
        baseUrl: identityBase,
        userCode,
        fetchImpl: withBearer(token.trim()),
      });
      setNotice({ kind: "ok", text: `Approved ${userCode.trim()}.` });
    } catch (e) {
      setNotice({
        kind: "err",
        text:
          e instanceof CeremonyRequestError
            ? e.message
            : "The Identity API did not answer.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={lead ? "approve" : undefined}>
      {lead ? (
        <h1 ref={focusOnMount} tabIndex={-1}>
          Approve this device
        </h1>
      ) : (
        <h2>Approve this device</h2>
      )}
      {claimId === undefined ? null : (
        <p className="hint">
          Claim <code>{claimId}</code> is not settled here. Use the Identity
          console.
        </p>
      )}
      <div className="field">
        <label htmlFor="user-code">User code</label>
        <input
          id="user-code"
          value={userCode}
          onChange={(e) => setUserCode(e.target.value.toUpperCase())}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          disabled={busy}
        />
      </div>
      {ownsTokenField ? (
        <TokenField value={token} onChange={onTokenChange} disabled={busy} />
      ) : null}
      <button
        type="button"
        className="primary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void approve()}
      >
        {busy ? "Approving…" : "Approve"}
      </button>
      <Status notice={notice} />
    </section>
  );
}
