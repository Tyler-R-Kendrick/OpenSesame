import {
  type ClaimPresentation,
  ClaimRequestError,
  createOpenSesame,
} from "@opensesame/sdk-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearClaimStash,
  readClaimStash,
  writeClaimStash,
} from "../lib/claim-stash.js";
import { readFragmentToken } from "../lib/deep-link.js";
import { readDropFragment } from "../lib/drop.js";
import { consoleOrigin, issuer } from "../lib/issuer.js";
import { DropAcceptance } from "./DropAcceptance.js";

interface Claim {
  id: string;
  type: string;
  state: string;
  targetManifestDigest: string;
  /** Accepting names every item; the server refuses a wildcard. */
  itemIds: string[];
}

/**
 * Where the page is in the ceremony. `paused` keeps the bearer while something
 * outside this page is settled — choosing an identity, or a failure worth
 * retrying — and every other state is either asking for a token or holding an
 * open claim, so an error can never leave the page with nothing to act on.
 */
type Phase =
  | { kind: "token" }
  | { kind: "loading" }
  | {
      kind: "paused";
      token: string;
      presented: boolean;
      reason: "identity" | "retry";
    }
  | { kind: "open"; token: string; claim: Claim }
  | { kind: "drop"; token: string; fragmentKey: string }
  | { kind: "done" };

/** States a claim can still be accepted from. */
const OPEN: ReadonlySet<string> = new Set([
  "presented",
  "authenticated",
  "reviewed",
]);

/**
 * An itemless claim accepts an empty set — the manifest digest on the page is
 * what the reviewer vouches for. An *absent* `items` is a different thing: the
 * server projects the field on every claim, so its absence means whatever is
 * answering does not report what a claim covers, and there is nothing to
 * accept by id. Refuse rather than guess.
 */
function toClaim(presented: ClaimPresentation): Claim {
  if (!Array.isArray(presented.items)) {
    throw new Error(
      "This service did not report what the claim covers, so there was nothing to accept by id. Ask for a fresh claim link.",
    );
  }
  return {
    id: presented.id,
    type: presented.type,
    state: presented.state,
    targetManifestDigest: presented.targetManifestDigest,
    itemIds: presented.items.map((item) => item.id),
  };
}

function describe(e: Error | null, fallback: string): string {
  if (e instanceof ClaimRequestError) {
    if (e.status === 401 || e.status === 404) {
      return "This claim link is no longer valid. Ask for a fresh one.";
    }
    if (e.status === 410) return "This claim expired. Ask for a fresh one.";
    if (e.status === 409 || e.status === 422) {
      return "This claim has already been decided.";
    }
  }
  return e instanceof Error ? e.message : fallback;
}

/**
 * Shareable claim ceremony — the hosted-page tier of ADR 0045. Same machine
 * and fences as the console's ClaimPage, plus a guest path: a recipient with
 * no account continues as a provisional principal minted in place, and
 * claiming an identity later keeps that principal id.
 */
export function ClaimCeremony() {
  const [phase, setPhase] = useState<Phase>({ kind: "token" });
  const [typed, setTyped] = useState("");
  const [userCode, setUserCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [startingGuest, setStartingGuest] = useState(false);

  /** The bearer being loaded, so the same one is never presented twice. */
  const inFlight = useRef<string | null>(null);
  /** Which load may still speak: a superseded one must not undo the winner. */
  const run = useRef(0);

  /** Read the claim this bearer opens, presenting it first if it is unspent. */
  const load = useCallback(async (token: string, presented: boolean) => {
    // A repeat of the same bearer — a double-mount, or a second click — must not
    // present twice: the second attempt would be refused as spent and its
    // failure would discard what the first one succeeded in doing.
    if (inFlight.current === token) return;
    inFlight.current = token;
    const id = ++run.current;
    const mine = () => run.current === id;
    const sesame = createOpenSesame({ issuer });
    setError(null);
    setPhase({ kind: "loading" });
    try {
      // Completing attaches ownership to whoever accepts, so there must be a
      // principal before the token is spent — and the same one at the end.
      const signedIn = (await sesame.getSession())?.sub ?? null;
      if (!mine()) return;
      if (!signedIn) {
        writeClaimStash({ token, presented });
        setPhase({ kind: "paused", token, presented, reason: "identity" });
        return;
      }

      let fresh: ClaimPresentation;
      if (presented) {
        const saved = readClaimStash();
        // A presented claim without both is unresumable: the id says which claim
        // to read, and the principal says whose review this is.
        if (!saved?.claimId || !saved.principalId) {
          clearClaimStash();
          setPhase({ kind: "token" });
          setError(
            "This claim was already presented and cannot be reopened here. Ask for a fresh claim link.",
          );
          return;
        }
        if (saved.principalId !== signedIn) {
          clearClaimStash();
          setPhase({ kind: "token" });
          setError(
            "This claim was opened by a different account in this tab. Open the claim link again to review it as yourself.",
          );
          return;
        }
        // Presenting twice is refused, and a stashed snapshot cannot say whether
        // the claim has since expired or been decided: read it back instead.
        fresh = await sesame.readClaim(saved.claimId, token);
      } else {
        fresh = await sesame.presentClaim(token);
      }
      // Superseded: the page has moved on to another bearer, and writing this
      // one's stash would take that away from it.
      if (!mine()) return;

      if (!OPEN.has(fresh.state)) {
        clearClaimStash();
        setPhase({ kind: "token" });
        setError(
          fresh.state === "completed"
            ? "This claim was already completed."
            : `This claim is ${fresh.state} and can no longer be accepted.`,
        );
        return;
      }
      writeClaimStash({
        token,
        presented: true,
        claimId: fresh.id,
        principalId: signedIn,
      });
      setPhase({ kind: "open", token, claim: toClaim(fresh) });
    } catch (e) {
      if (!mine()) return;
      // A refusal the bearer cannot come back from should not linger in storage,
      // and the page falls back to asking for a token. A network failure keeps
      // both, so the same claim can be retried.
      const spent = e instanceof ClaimRequestError && e.spent;
      if (spent) {
        clearClaimStash();
        setPhase({ kind: "token" });
      } else {
        setPhase({ kind: "paused", token, presented, reason: "retry" });
      }
      setError(
        describe(
          e instanceof Error ? e : null,
          "Could not load this claim. Check the token and try again.",
        ),
      );
    } finally {
      // Only the newest load owns the guard; an older one clearing it would let
      // its own bearer be presented a second time.
      if (mine()) inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    // A drop link carries the decryption key beside the bearer — that is the
    // only client-side signal that this is a drop before the single
    // presentation happens (the manifest kind is verified after it, inside
    // the decrypt step). Fragment discipline first, either way.
    const drop = readDropFragment(window.location.hash);
    if (drop) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      setPhase({ kind: "drop", token: drop.token, fragmentKey: drop.key });
      return;
    }
    const fromLink = readFragmentToken(window.location.hash);
    if (fromLink) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void load(fromLink, false);
      return;
    }
    // Reload, or back from choosing an identity: the token is gone from the URL.
    const saved = readClaimStash();
    if (saved) void load(saved.token, saved.presented);
  }, [load]);

  /**
   * The guest path: mint a provisional principal, then re-run the load so the
   * claim presents to it. The token is only spent after an identity exists.
   */
  async function continueAsGuest(token: string, presented: boolean) {
    setStartingGuest(true);
    setError(null);
    try {
      const sesame = createOpenSesame({
        issuer,
        clientId: "opensesame-ceremonies",
      });
      await sesame.continueAnonymously();
      await load(token, presented);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start a guest session. Is the Identity API up?",
      );
    } finally {
      setStartingGuest(false);
    }
  }

  async function complete() {
    if (phase.kind !== "open") return;
    const { token, claim } = phase;
    const sesame = createOpenSesame({ issuer });
    setCompleting(true);
    setError(null);
    try {
      // The principal is read again here, not trusted from when the claim was
      // read: ownership must attach to the account that is accepting now.
      const signedIn = (await sesame.getSession())?.sub ?? null;
      const saved = readClaimStash();
      if (!signedIn || saved?.principalId !== signedIn) {
        clearClaimStash();
        setPhase({ kind: "token" });
        setError(
          "The identity in this tab changed while this claim was open, so it was not accepted. Open the claim link again to review it as yourself.",
        );
        return;
      }
      // A new client was built for this step, so it never saw the presentation:
      // pass the claim bearer, which completing requires alongside the principal.
      // The user code is the human consent second channel — holding the link
      // alone must not be enough to accept.
      await sesame.completeClaim(claim.id, {
        acceptedItemIds: claim.itemIds,
        userCode: userCode.trim(),
        claimToken: token,
      });
      // Spent for good; nothing left worth keeping in this tab.
      clearClaimStash();
      setPhase({ kind: "done" });
    } catch (e) {
      if (e instanceof ClaimRequestError && e.spent) {
        clearClaimStash();
        setPhase({ kind: "token" });
      }
      setError(
        describe(
          e instanceof Error ? e : null,
          "Claim could not be completed. Try again.",
        ),
      );
    } finally {
      setCompleting(false);
    }
  }

  if (phase.kind === "drop") {
    // The drop branch is a different ceremony entirely — account-free, no
    // claim chrome, reveal in this sitting only.
    return (
      <DropAcceptance token={phase.token} fragmentKey={phase.fragmentKey} />
    );
  }

  return (
    <section className="panel">
      <div className="badge">Accept a claim</div>
      <h1>Review and accept this claim</h1>
      <p>
        Someone shared ownership or delegation with you. Accepting attaches it
        to your identity — a guest identity works, and linking an account later
        keeps everything. This page never shows raw credentials.
      </p>
      {phase.kind === "token" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const next = typed.trim();
            if (!next) return;
            // Presenting spends the token, so wait for the whole thing rather
            // than reading a claim on every keystroke.
            setTyped("");
            void load(next, false);
          }}
        >
          <div className="field">
            <label htmlFor="claim-token">Paste claim token</label>
            <input
              id="claim-token"
              placeholder="osc_clm_…"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={!typed.trim()}>
              Review claim
            </button>
          </div>
        </form>
      ) : null}
      {phase.kind === "loading" ? (
        <output className="lede" aria-busy="true">
          Loading claim details…
        </output>
      ) : null}
      {phase.kind === "paused" && phase.reason === "identity" ? (
        <div>
          <p>
            Choose who accepts. Nothing is presented until there is an identity
            to accept as, so the claim is waiting, not lost.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={startingGuest}
              aria-busy={startingGuest}
              onClick={() => void continueAsGuest(phase.token, phase.presented)}
            >
              {startingGuest ? "Starting…" : "Continue as guest"}
            </button>
            <button
              type="button"
              onClick={() => void load(phase.token, phase.presented)}
            >
              I signed in already
            </button>
          </div>
          <p className="fine">
            Have an account? Sign in at <a href={consoleOrigin}>the console</a>{" "}
            in another tab, then come back and press "I signed in already".
          </p>
        </div>
      ) : null}
      {phase.kind === "paused" && phase.reason === "retry" ? (
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => void load(phase.token, phase.presented)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {phase.kind === "open" ? (
        <div>
          <p>
            Target type: <strong>{phase.claim.type}</strong>
          </p>
          <p>
            Manifest digest: <code>{phase.claim.targetManifestDigest}</code>
          </p>
          <p>State: {phase.claim.state}</p>
          <div className="field">
            <label htmlFor="consent-code">Consent code</label>
            <input
              id="consent-code"
              autoComplete="one-time-code"
              placeholder="ABCD-EFGH"
              value={userCode}
              disabled={completing}
              onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            />
            <p className="fine">
              The person who shared this with you has the code. It proves
              consent beyond holding the link.
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={completing || !userCode.trim()}
              aria-busy={completing}
              onClick={() => void complete()}
            >
              {completing ? "Completing…" : "Accept claim"}
            </button>
          </div>
        </div>
      ) : null}
      {phase.kind === "done" ? (
        <output className="ok">
          Claim completed. It is attached to your identity — if you continued as
          a guest, link an account later to keep the same principal id.
        </output>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
