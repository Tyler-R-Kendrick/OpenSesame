import {
  InteractionError,
  createInteractionClient,
} from "@opensesame/ceremony-kit";
import type {
  ApprovalProof,
  InteractionDetail,
  InteractionSummary,
} from "@opensesame/os-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OutcomePanel } from "./OutcomePanel.js";
import { type Notice, Status } from "./Status.js";
import { TokenField } from "./TokenField.js";
import {
  type Mechanism,
  type Outcome,
  chooseMechanism,
  outcomeOfErrorCode,
  outcomeOfStatus,
  viewOf,
} from "./approval.js";
import {
  StepUpError,
  assertPasskey,
  hasWebAuthn,
  identityBase,
  verifyTotpCode,
} from "./identity.js";

/**
 * The approval surface (ADR 0086).
 *
 * When this app is opened on an interaction link, this *is* the app. Everything
 * else — enrolling a passkey, minting a TOTP secret — is a maintenance chore
 * that has no business competing with a question somebody is waiting on.
 *
 * The flow is the one ADR 0086 describes and nothing more: resolve the
 * reference unauthenticated, authenticate if the interaction says an approver
 * is required, read the detail, show it, and answer it while echoing the
 * digest. Every failure lands in a terminal panel or a status line; none of
 * them leaves the screen looking answerable when it is not.
 */

/**
 * The sentence for a digest that no longer matches.
 *
 * Taken from `InteractionError` rather than retyped so the wording the client
 * refuses with and the wording the server refuses with are literally the same
 * string. Two spellings of "this changed" would read, to the person holding the
 * phone, as two different problems.
 */
const DIGEST_REFUSAL = new InteractionError(0, "digest_mismatch").message;

/** The kit's own words for "you are not signed in", reused for the same reason. */
const SIGN_IN_PROMPT = new InteractionError(401, "approval_required").message;

/**
 * An interaction that arrived without a digest.
 *
 * Not the same failure as a digest that changed, and it must not borrow that
 * sentence: nothing changed, there was never anything to echo. Answering would
 * mean sending a decision that names no operation, which ADR 0086 §4 is
 * precisely about not doing.
 */
const UNANSWERABLE = "This request carries nothing to approve.";

/** Which refusal applies: nothing to echo, or something that stopped matching. */
function refusalFor(detail: InteractionDetail): string {
  return detail.requestDigest === undefined ? UNANSWERABLE : DIGEST_REFUSAL;
}

type Phase =
  | { kind: "resolving" }
  | { kind: "signin" }
  | { kind: "open"; detail: InteractionDetail }
  | { kind: "done"; outcome: Outcome };

export interface ApprovalProps {
  /** The opaque reference from the link. Authorizes nothing on its own. */
  interactionRef: string;
  token: string;
  onTokenChange: (next: string) => void;
}

export function Approval({
  interactionRef,
  token,
  onTokenChange,
}: ApprovalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "resolving" });
  const [summary, setSummary] = useState<InteractionSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  /**
   * The bearer, read at call time rather than captured.
   *
   * The interaction client is built once — rebuilding it per keystroke would
   * re-run the mount effect and re-resolve the interaction on every character
   * typed into the token field — so the token reaches it through a ref that an
   * effect keeps current. Effects flush before the next event, so a click that
   * follows typing always sees the token that was typed.
   */
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  /**
   * The digest this screen actually put in front of a human, frozen.
   *
   * Set once, on the first detail that carries one, and never overwritten. That
   * is the whole mechanism behind ADR 0086 §4 on the client side: if a later
   * read hands back a different digest, the operation on the screen and the
   * operation in the request have diverged, and this app must refuse rather
   * than quietly approve whichever one it happens to be holding.
   */
  const shownDigest = useRef<string | null>(null);

  const client = useMemo(
    () =>
      createInteractionClient({
        baseUrl: identityBase,
        // Wrapped rather than passed by reference so the call resolves the
        // current global `fetch` — the app is bundled against whatever the
        // page provides, and tests replace it.
        fetchImpl: (input, init) => fetch(input, init),
        bearer: () => {
          const held = tokenRef.current.trim();
          return held.length === 0 ? null : held;
        },
      }),
    [],
  );

  /**
   * Turn a failure into either a terminal panel or a line to read.
   *
   * The split is the point: five of the kit's nine codes mean the question is
   * over and must replace the screen, and the other four mean it is still open
   * and the human can do something. Nothing from the response reaches the
   * screen — `InteractionError` already carries wording the kit owns.
   *
   * The thrown value keeps its own type parameter rather than being widened:
   * a `catch` binding is whatever the runtime threw, and the two `instanceof`
   * checks below are what turn it into something this screen may read. Naming
   * it `unknown` would only move that decoding out of sight.
   */
  const report = useCallback(<Thrown,>(e: Thrown) => {
    if (e instanceof InteractionError) {
      const settled = outcomeOfErrorCode(e.code);
      if (settled !== undefined) {
        setPhase({ kind: "done", outcome: settled });
        return;
      }
      if (e.code === "approval_required") {
        setPhase({ kind: "signin" });
        // The sign-in phase already carries the kit's "sign in to answer this"
        // line, so repeating it as a status would put one sentence on screen
        // twice. A token that *was* pasted and still came back 401 is a
        // different fact, and the human has no other way to learn it.
        setNotice(
          tokenRef.current.trim().length === 0
            ? null
            : { kind: "err", text: "That token was not accepted." },
        );
        return;
      }
      setNotice({ kind: "err", text: e.message });
      return;
    }
    setNotice({
      kind: "err",
      text: e instanceof Error ? e.message : "That did not work.",
    });
  }, []);

  const openDetail = useCallback(async () => {
    try {
      const detail = await client.readInteraction(interactionRef);
      const settled = outcomeOfStatus(detail.status);
      if (settled !== undefined) {
        setPhase({ kind: "done", outcome: settled });
        return;
      }
      const digest = detail.requestDigest;
      if (digest !== undefined && shownDigest.current === null) {
        shownDigest.current = digest;
      }
      // Said now, not only when a button is pressed. A person who comes back to
      // a screen whose request has been rewritten under them should read that
      // before they reach for it, not after.
      setNotice(
        shownDigest.current === digest
          ? null
          : { kind: "err", text: refusalFor(detail) },
      );
      setPhase({ kind: "open", detail });
    } catch (e) {
      report(e);
    }
  }, [client, interactionRef, report]);

  /**
   * Resolve the reference. Run on mount, and again when a human retries.
   *
   * No cancellation guard: resolving is an idempotent GET whose only side
   * effect server-side is the `present` display fact (ADR 0086 §3, idempotent
   * by design), and a state write after unmount is discarded by React rather
   * than warned about. A guard here would be ceremony that protects nothing.
   */
  const resolve = useCallback(async () => {
    setPhase({ kind: "resolving" });
    setNotice(null);
    try {
      const resolved = await client.resolveInteraction(interactionRef);
      setSummary(resolved);
      const settled = outcomeOfStatus(resolved.status);
      if (settled !== undefined) {
        setPhase({ kind: "done", outcome: settled });
        return;
      }
      // Scanning is not approving (ADR 0086 §3): the summary says a question
      // exists and nothing about what it asks, so the detail read — and the
      // bearer it needs — comes next, never as part of resolving.
      if (resolved.requiresApprover && tokenRef.current.trim().length === 0) {
        setPhase({ kind: "signin" });
        return;
      }
      await openDetail();
    } catch (e) {
      report(e);
    }
  }, [client, interactionRef, openDetail, report]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  /**
   * Re-read the request when the phone comes back to the foreground.
   *
   * A cross-device approval is a screen people put down. Between putting it
   * down and picking it up, the request behind it can lapse, be withdrawn, be
   * answered elsewhere, or — the case that matters — be replaced by a
   * different one. Re-reading on return is what turns the frozen digest above
   * from a theory into something that actually fires, and it costs one request
   * on a screen that exists for exactly one decision.
   */
  const openPhase = phase.kind === "open";
  useEffect(() => {
    if (!openPhase) return;
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      void openDetail();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [openPhase, openDetail]);

  /**
   * Send focus to the heading whenever the question changes shape.
   *
   * A callback ref keyed on the phase rather than an effect: the heading is a
   * different element in each phase, so React remounts it and this fires
   * exactly on the transitions that matter. Without it a screen-reader user
   * answers a question, the panel is replaced by its outcome, and their focus
   * is left pointing at a button that no longer exists.
   */
  const focusOnMount = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus();
  }, []);

  /**
   * The digest both answers must echo, or `undefined` when neither may be sent.
   *
   * Checked here — before the step-up, and therefore before any request —
   * rather than left to the kit's own guard inside `approveInteraction`. The
   * kit's check is the structural backstop and must stay; this one exists
   * because a step-up costs a human a biometric prompt or a code from their
   * authenticator, and spending that on a request that has already changed
   * teaches people to approve through warnings.
   */
  function echoableDigest(detail: InteractionDetail): string | undefined {
    const displayed = shownDigest.current;
    if (displayed === null || detail.requestDigest !== displayed) {
      return undefined;
    }
    return displayed;
  }

  function refuse(detail: InteractionDetail) {
    setNotice({ kind: "err", text: refusalFor(detail) });
  }

  function settle(detail: InteractionDetail, fallback: Outcome) {
    setPhase({
      kind: "done",
      outcome: outcomeOfStatus(detail.status) ?? fallback,
    });
  }

  async function deny(detail: InteractionDetail) {
    const digest = echoableDigest(detail);
    if (digest === undefined) {
      refuse(detail);
      return;
    }
    setNotice(null);
    setBusy("deny");
    try {
      // No proof, by design. Refusing costs nothing to prove — the expensive
      // half of an authorization is the yes — and a deny that needed an
      // authenticator would be a deny people skip.
      settle(
        await client.denyInteraction(interactionRef, {
          requestDigest: digest,
        }),
        "denied",
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  }

  async function approve(detail: InteractionDetail, mechanism: Mechanism) {
    const digest = echoableDigest(detail);
    if (digest === undefined) {
      refuse(detail);
      return;
    }
    setNotice(null);
    setBusy("approve");
    try {
      const bearer = token.trim();
      let credentialRef: string | undefined;
      if (mechanism.mechanism === "webauthn") {
        credentialRef = await assertPasskey(bearer);
      } else {
        await verifyTotpCode(bearer, code);
      }
      // Bound to the digest that was displayed, echoed alongside the digest the
      // screen is holding. They are the same value by the check above, which is
      // what lets the kit's own equality guard be a backstop rather than the
      // first line of defence.
      const proof: ApprovalProof = {
        mechanism: mechanism.mechanism,
        boundDigest: digest,
        assurance: mechanism.assurance,
        verifiedAt: new Date(),
        ...(credentialRef === undefined ? undefined : { credentialRef }),
      };
      settle(
        await client.approveInteraction(interactionRef, {
          requestDigest: digest,
          proof,
        }),
        "approved",
      );
    } catch (e) {
      if (e instanceof StepUpError) {
        setNotice({ kind: "err", text: e.message });
        return;
      }
      report(e);
    } finally {
      setBusy(null);
    }
  }

  function signIn() {
    if (token.trim().length === 0) {
      setNotice({ kind: "err", text: "Paste a session access token." });
      return;
    }
    setNotice(null);
    void openDetail();
  }

  if (phase.kind === "done") {
    return <OutcomePanel outcome={phase.outcome} headingRef={focusOnMount} />;
  }

  if (phase.kind === "resolving") {
    // A failure that ended nothing leaves the screen here, so it needs a way
    // out: without one, a rate limit or a flaky network is indistinguishable
    // from a request that never loads, and the only recourse is scanning the
    // code again.
    const stalled = notice !== null;
    return (
      <section className="approve" aria-busy={!stalled}>
        <h1 ref={focusOnMount} tabIndex={-1}>
          {stalled ? "Could not load" : "Loading request"}
        </h1>
        <Status notice={notice} />
        {stalled ? (
          <button
            type="button"
            className="primary"
            onClick={() => void resolve()}
          >
            Try again
          </button>
        ) : null}
      </section>
    );
  }

  if (phase.kind === "signin") {
    return (
      <section className="approve">
        <h1 ref={focusOnMount} tabIndex={-1}>
          Sign in
        </h1>
        <ul className="facts">
          <li>{SIGN_IN_PROMPT}</li>
          {/* Same `Expires <ISO>` shape the kit renders once the detail
              arrives, so the row does not change form under the reader when
              it does. The instant is the server's; this app has no clock. */}
          {summary === null ? null : (
            <li>{`Expires ${summary.expiresAt.toISOString()}`}</li>
          )}
        </ul>
        <TokenField value={token} onChange={onTokenChange} />
        <button type="button" className="primary" onClick={signIn}>
          Continue
        </button>
        <Status notice={notice} />
      </section>
    );
  }

  const { detail } = phase;
  const view = viewOf(detail);
  const mechanism = chooseMechanism(detail, hasWebAuthn());
  const missingCode = mechanism?.needsCode === true && code.trim().length === 0;

  return (
    <section className="approve">
      <h1 ref={focusOnMount} tabIndex={-1}>
        {view.title}
      </h1>
      {view.match === undefined ? null : (
        <p className="match">
          <span className="match__label">Match</span>
          <strong className="match__value">{view.match}</strong>
        </p>
      )}
      <ul className="facts">
        {view.facts.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {mechanism === undefined ? (
        <p className="hint">Needs a passkey. This browser has none.</p>
      ) : null}
      {mechanism?.needsCode === true ? (
        <div className="field">
          <label htmlFor="stepup-code">Code</label>
          <input
            id="stepup-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={busy !== null}
          />
        </div>
      ) : null}
      <div className="decide">
        {mechanism === undefined ? null : (
          <button
            type="button"
            className="primary"
            disabled={busy !== null || missingCode}
            aria-busy={busy === "approve"}
            onClick={() => void approve(detail, mechanism)}
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        )}
        <button
          type="button"
          className="danger"
          disabled={busy !== null}
          aria-busy={busy === "deny"}
          onClick={() => void deny(detail)}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
      <Status notice={notice} />
    </section>
  );
}
