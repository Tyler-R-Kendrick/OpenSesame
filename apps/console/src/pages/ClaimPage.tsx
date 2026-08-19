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

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

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
 * outside this page is settled — signing in, or a failure worth retrying — and
 * every other state is either asking for a token or holding an open claim, so
 * an error can never leave the page with nothing to act on.
 */
type Phase =
  | { kind: "token" }
  | { kind: "loading" }
  | {
      kind: "paused";
      token: string;
      presented: boolean;
      reason: "signIn" | "retry";
    }
  | { kind: "open"; token: string; claim: Claim }
  | { kind: "done" };

/** States a claim can still be accepted from. */
const OPEN: ReadonlySet<string> = new Set([
  "presented",
  "authenticated",
  "reviewed",
]);

/**
 * Project a presentation into what the page needs to accept it.
 *
 * Exported for tests: an itemless claim must map to an empty accepted set
 * rather than `undefined`, which previously read as "unknown" and blocked
 * completion for every claim the server actually mints.
 */
export function toClaim(presented: ClaimPresentation): Claim {
  return {
    id: presented.id,
    type: presented.type,
    state: presented.state,
    targetManifestDigest: presented.targetManifestDigest,
    // An absent `items` is the empty set, not an unknown one: a claim with
    // nothing to enumerate has nothing to name, and the manifest digest on
    // screen is what the reviewer is vouching for.
    itemIds: presented.items?.map((item) => item.id) ?? [],
  };
}

/**
 * The decision sent to the server.
 *
 * Completion requires three things together — the accepted items, the claim
 * bearer, and the user code that proves human consent. Building it in one
 * place keeps a caller from omitting the code, which the server rejects.
 */
export function buildClaimCompletion(
  claim: Pick<Claim, "itemIds">,
  userCode: string,
  claimToken: string,
) {
  return {
    acceptedItemIds: claim.itemIds,
    userCode: userCode.trim(),
    claimToken,
  };
}

function describe(e: unknown, fallback: string): string {
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
 * Claim ownership review — distinct from device/CLI authorization.
 */
export function ClaimPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "token" });
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [userCode, setUserCode] = useState("");

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
        setPhase({ kind: "paused", token, presented, reason: "signIn" });
        setError(
          presented
            ? "Sign in to finish reviewing this claim. It is waiting, not lost."
            : "Sign in first. Reviewing spends this token, so nothing is presented until there is a principal to accept as.",
        );
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
          e,
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
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const fromLink = new URLSearchParams(hash).get("token");
    if (fromLink) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      void load(fromLink, false);
      return;
    }
    // Reload, or back from sign-in: the link's token is gone from the URL.
    const saved = readClaimStash();
    if (saved) void load(saved.token, saved.presented);
  }, [load]);

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
          "The account signed in changed while this claim was open, so it was not accepted. Open the claim link again to review it as yourself.",
        );
        return;
      }
      // A new client was built for this step, so it never saw the presentation:
      // pass the claim bearer, which completing requires alongside the principal.
      // The user code is the human consent step the server requires alongside
      // the bearer: holding the link must not be enough to accept.
      await sesame.completeClaim(
        claim.id,
        buildClaimCompletion(claim, userCode, token),
      );
      // Spent for good; nothing left worth keeping in this tab.
      clearClaimStash();
      setPhase({ kind: "done" });
    } catch (e) {
      if (e instanceof ClaimRequestError && e.spent) {
        clearClaimStash();
        setPhase({ kind: "token" });
      }
      setError(describe(e, "Claim could not be completed. Try again."));
    } finally {
      setCompleting(false);
    }
  }

  return (
    <section className="panel">
      <div className="badge">Claim ownership</div>
      <h1>Claim ownership of this agent/project/resources</h1>
      <p>
        This ceremony attaches durable ownership or delegation. It is not the
        same as authorizing a CLI session.
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
      {phase.kind === "paused" ? (
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => void load(phase.token, phase.presented)}
          >
            {phase.reason === "signIn" ? "I have signed in" : "Try again"}
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
            <label htmlFor="claim-user-code">Consent code</label>
            <input
              id="claim-user-code"
              autoComplete="one-time-code"
              placeholder="ABCD-EFGH"
              value={userCode}
              disabled={completing}
              onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={completing || !userCode.trim()}
              aria-busy={completing}
              onClick={() => void complete()}
            >
              {completing ? "Completing…" : "Complete claim"}
            </button>
          </div>
        </div>
      ) : null}
      {phase.kind === "done" ? (
        <output className="ok">
          Claim completed. Ownership is attached to your principal.
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
