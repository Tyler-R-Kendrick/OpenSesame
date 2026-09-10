import { useEffect, useRef, useState } from "react";
import { type DelegationOffer, claimDelegation } from "../../lib/access.js";
import { presentOffer } from "../../lib/claim.js";
import { errorText } from "../connections/shared.js";

/** Present is single-use; only explicit acceptance claims the reviewed items. */
function useClaim(onDone: (claimed: boolean) => void) {
  const [claimToken, setClaimToken] = useState("");
  const [userCode, setUserCode] = useState("");
  const [offer, setOffer] = useState<DelegationOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (!offer) setOffer(await presentOffer(claimToken.trim()));
      else {
        await claimDelegation({
          claimToken: claimToken.trim(),
          userCode: userCode.trim(),
          acceptedItemIds: offer.items.map((item) => item.id),
        });
        setClaimToken("");
        setUserCode("");
        onDone(true);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  return {
    claimToken,
    setClaimToken,
    userCode,
    setUserCode,
    offer,
    busy,
    error,
    submit,
  };
}

export function ClaimAccessCeremony({
  online,
  onDone,
}: { online: boolean; onDone: (claimed: boolean) => void }) {
  const state = useClaim(onDone);
  return (
    <section className="panel identity-ceremony">
      <div className="panel__head">
        <h2>Claim access</h2>
      </div>
      <form
        className="panel__body identity-claim"
        onSubmit={(event) => {
          event.preventDefault();
          void state.submit();
        }}
      >
        {state.offer ? (
          <OfferScope offer={state.offer} />
        ) : (
          <ClaimFields state={state} />
        )}
        {state.error ? (
          <p role="alert" className="note note--err">
            {state.error}
          </p>
        ) : null}
        <div className="actions actions--end">
          <button
            type="button"
            className="btn"
            disabled={state.busy}
            onClick={() => onDone(false)}
          >
            Back
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            aria-busy={state.busy || undefined}
            disabled={
              state.busy ||
              !online ||
              !state.claimToken.trim() ||
              !state.userCode.trim()
            }
          >
            {state.busy ? "Asking…" : state.offer ? "Accept" : "Review offer"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ClaimFields({ state }: { state: ReturnType<typeof useClaim> }) {
  const tokenRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    tokenRef.current?.focus();
  }, []);
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="identity-claim-token">
          Claim token
        </label>
        <input
          id="identity-claim-token"
          ref={tokenRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={state.claimToken}
          disabled={state.busy}
          onChange={(event) => state.setClaimToken(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="identity-claim-code">
          User code
        </label>
        <input
          id="identity-claim-code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="WORD-WORD"
          required
          value={state.userCode}
          disabled={state.busy}
          onChange={(event) => state.setUserCode(event.target.value)}
        />
      </div>
    </>
  );
}

function OfferScope({ offer }: { offer: DelegationOffer }) {
  return (
    <ul className="identity-rows">
      {offer.items.map((item) => (
        <li className="identity-row" key={item.id}>
          <div className="identity-row__main">
            <div className="identity-row__id">
              <h3>{item.displayName}</h3>
              <code className="identity-ref">{item.connectionId}</code>
            </div>
            {item.actions.map((action) => (
              <span className="chip" key={action}>
                {action}
              </span>
            ))}
            <span className="chip">{item.executionMode}</span>
          </div>
          {item.resources.length > 0 ? (
            <p className="hint">{item.resources.join(", ")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
