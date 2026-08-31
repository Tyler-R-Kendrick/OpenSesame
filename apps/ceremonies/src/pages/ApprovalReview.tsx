import {
  assertionPayload,
  isPublicKeyCredential,
  parsePublicKeyCredentialRequestOptionsJson,
  requestOptionsFromJson,
} from "@opensesame/sdk-browser";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  type ApprovalDecision,
  ApprovalError,
  type ApprovalRequirement,
  type AuthorizationRequestView,
  NO_CREDENTIALS_API,
  approvalSeams,
  beginActivation,
  channelLabel,
  completeActivation,
  describeDetail,
  isTerminal,
  loadRequest,
  loadRequirement,
  reportUnrecognized,
  requirementSentences,
  riskSentence,
  settle,
} from "../lib/approvals.js";

/**
 * The approval review ceremony (ADR 0081).
 *
 * This is where an opaque rendezvous reference lands. A notification told
 * somebody that something was waiting and, deliberately, nothing else — so
 * everything that makes a decision possible has to be here, said plainly:
 *
 *   who is asking · what would happen · how long it is good for ·
 *   why this one needs more proof · which channel brought me here ·
 *   what to do if I don't recognise it
 *
 * The high-assurance path is explicit rather than one-tap. A person reads,
 * says out loud (a checkbox) that this is what they mean to allow, and only
 * then touches an authenticator. A single tap that both reads the request and
 * signs for it is a tap that can be phished into meaning anything.
 */

const COMPARISON = /^[0-9]{6}$/;

interface Terminal {
  title: string;
  message: string;
}

export function ApprovalReview() {
  const params = useParams();
  const id = params.ref ?? "";

  const [request, setRequest] = useState<AuthorizationRequestView | null>(null);
  const [requirement, setRequirement] = useState<ApprovalRequirement | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [comparison, setComparison] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = useCallback((e: Error, fallbackTitle: string) => {
    if (e instanceof ApprovalError) {
      if (isTerminal(e.code)) {
        setTerminal({ title: fallbackTitle, message: e.message });
        return;
      }
      // A mismatch is not a validation error. It is the one signal this whole
      // ceremony exists to raise, so it gets its own wording and its own box.
      if (e.code === "comparison_mismatch") {
        setWarning(e.message);
        return;
      }
      setError(e.message);
      return;
    }
    setError(e.message);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadRequest(id);
      setRequest(loaded);
      setRequirement(await loadRequirement(id));
    } catch (e) {
      fail(
        e instanceof Error ? e : new Error(String(e)),
        "This request is no longer open",
      );
    } finally {
      setLoading(false);
    }
  }, [fail, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Approve or deny, at whatever assurance the policy demands.
   *
   * The order is the security property and it is fixed: mint an activation
   * against the digest that was *displayed*, run the WebAuthn ceremony over
   * the challenge that comes back, hand the assertion in for verification,
   * and only then settle — naming the activation rather than re-proving it.
   * Settling first and proving afterwards would mean the decision existed
   * before the proof did.
   */
  async function decide(decision: ApprovalDecision) {
    if (!request || !requirement) return;
    setError(null);
    setWarning(null);
    setDegraded(null);
    setBusy(decision);
    try {
      const value = comparison.trim();
      if (requirement.requireComparison && !COMPARISON.test(value)) {
        setError(
          "Type the six-digit code shown where this request started. It is not sent to you here on purpose — carrying it across is what proves the two are the same request.",
        );
        return;
      }

      let activationId: string | undefined;
      if (requirement.requireTransactionBoundActivation) {
        const credentials = approvalSeams.credentialsApi();
        if (!credentials) {
          setDegraded(NO_CREDENTIALS_API);
          return;
        }
        const challenge = await beginActivation(
          id,
          decision,
          request.requestDigest,
        );
        const options = parsePublicKeyCredentialRequestOptionsJson(
          challenge.options,
        );
        if (!options) {
          setError(
            "The passkey challenge from the server was not in a shape this browser can use, so nothing was decided.",
          );
          return;
        }
        const credential = await credentials.get(
          requestOptionsFromJson(options),
        );
        if (!credential || !isPublicKeyCredential(credential)) {
          setError(
            "No passkey answered, so nothing was decided. Try again when your authenticator is ready.",
          );
          return;
        }
        await completeActivation(
          id,
          challenge.activationId,
          assertionPayload(credential),
        );
        activationId = challenge.activationId;
      }

      await settle(id, decision, {
        requestDigest: request.requestDigest,
        ...(activationId ? { activationId } : undefined),
        ...(requirement.requireComparison
          ? { comparisonValue: value }
          : undefined),
      });
      setDone(
        decision === "approve"
          ? "Approved. Whoever asked can go ahead with exactly what is listed above, and nothing else."
          : "Denied. Nothing was granted, and whoever asked has been told.",
      );
    } catch (e) {
      fail(
        e instanceof Error ? e : new Error(String(e)),
        "This request could not be decided",
      );
    } finally {
      setBusy(null);
    }
  }

  async function report() {
    if (!request) return;
    setError(null);
    setWarning(null);
    setBusy("report");
    try {
      await reportUnrecognized(id, request.requestDigest);
      setTerminal({
        title: "Refused and reported",
        message:
          "Thanks — this request was refused, and it was recorded as one you did not recognise so your operator can look into where it came from. Nothing was granted, and you do not need to do anything else. If you keep getting links like this one, treat them as phishing and tell whoever runs OpenSesame for you.",
      });
    } catch (e) {
      fail(
        e instanceof Error ? e : new Error(String(e)),
        "This request is no longer open",
      );
    } finally {
      setBusy(null);
    }
  }

  if (terminal) {
    return (
      <section className="panel" aria-labelledby="review-terminal">
        <div className="badge">Review a request</div>
        <h1 id="review-terminal">{terminal.title}</h1>
        <p>{terminal.message}</p>
        <p className="fine">
          <Link to="/inbox">See everything else waiting for you</Link>
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="panel" aria-labelledby="review-loading">
        <div className="badge">Review a request</div>
        <h1 id="review-loading">Reading this request…</h1>
        <output className="lede" aria-busy="true">
          Fetching what is being asked for.
        </output>
      </section>
    );
  }

  if (!request || !requirement) {
    return (
      <section className="panel" aria-labelledby="review-missing">
        <div className="badge">Review a request</div>
        <h1 id="review-missing">This request could not be read</h1>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  const settled = done !== null;

  return (
    <section className="panel" aria-labelledby="review-title">
      <div className="badge">Review a request</div>
      <h1 id="review-title">Someone is asking to use your authority</h1>

      <p>
        <strong>{request.bindingMessage}</strong>
      </p>
      <p className="fine">
        {request.requesterRef ? (
          <>
            Asked by <code>{request.requesterRef}</code>
            {request.requesterKind ? ` (${request.requesterKind})` : ""} ·{" "}
          </>
        ) : (
          <>This request does not name who asked · </>
        )}
        good until {new Date(request.expiresAt).toLocaleString()} · request{" "}
        <code>{request.requestDigest.slice(0, 12)}…</code>
      </p>

      <section aria-labelledby="review-what">
        <h2 id="review-what" className="sub">
          What this would let them do
        </h2>
        <ul className="index">
          {request.authorizationDetails.map((detail) => (
            <li key={`${detail.type}-${describeDetail(detail)}`}>
              {describeDetail(detail)}
            </li>
          ))}
        </ul>
        <p className="fine">
          Approving allows exactly this list and nothing beyond it.
        </p>
      </section>

      <section aria-labelledby="review-why">
        <h2 id="review-why" className="sub">
          Why this one asks for more
        </h2>
        <p>{riskSentence(requirement.riskClass)}</p>
        <ul className="index">
          {requirementSentences(requirement.required).map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
        {requirement.arrivedVia ? (
          <p className="fine">
            You got here from {channelLabel(requirement.arrivedVia)}. That
            channel only pointed you at this page — nothing about this request
            was decided there, and nothing about it was sent through it.
          </p>
        ) : null}
      </section>

      {requirement.requireComparison && !settled ? (
        <div className="field">
          <label htmlFor="comparison-code">
            Six-digit code from where this started
          </label>
          <input
            id="comparison-code"
            autoComplete="off"
            inputMode="numeric"
            maxLength={6}
            placeholder="123456"
            value={comparison}
            disabled={busy !== null}
            onChange={(e) =>
              setComparison(e.target.value.replace(/[^0-9]/g, ""))
            }
          />
        </div>
      ) : null}

      {!settled ? (
        <label className="confirm" htmlFor="review-confirm">
          <input
            id="review-confirm"
            type="checkbox"
            checked={confirmed}
            disabled={busy !== null}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            I have read what this would do, and I want to allow exactly that.
          </span>
        </label>
      ) : null}

      {!settled ? (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!confirmed || busy !== null}
            aria-busy={busy === "approve"}
            onClick={() => void decide("approve")}
          >
            {requirement.requireTransactionBoundActivation
              ? "Touch your passkey to approve"
              : "Approve"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "deny"}
            onClick={() => void decide("deny")}
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy !== null}
            aria-busy={busy === "report"}
            onClick={() => void report()}
          >
            I don't recognize this request
          </button>
        </div>
      ) : null}

      {done ? <output className="ok">{done}</output> : null}

      {warning ? (
        <p className="err" role="alert">
          {warning}
        </p>
      ) : null}

      {degraded ? (
        <p className="err" role="alert">
          {degraded}
        </p>
      ) : null}

      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}

      <p className="fine">
        If you were not expecting this, do not approve it. Use “I don't
        recognize this request” — that leaves it undecided and tells your
        operator. Nobody from OpenSesame will ever ask you to read a code back
        to them.
      </p>
    </section>
  );
}
