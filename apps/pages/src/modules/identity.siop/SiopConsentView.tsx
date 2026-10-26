import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconLogin, IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { SiopSocialChoice } from "../../lib/siop-social.js";
import { brandFor } from "../../screens/unlock/ProviderBrand.js";
import type { SiopConsentActions } from "./siop-consent-actions.js";
import type { SiopConsentState } from "./siop-consent-state.js";

function SiopPersonSelect({ state }: { state: SiopConsentState }) {
  const { person, people, busy, socialBusy, session, setPerson } = state;
  return (
    <div className="field">
      <label className="label" htmlFor="siop-consent-person">
        Person
      </label>
      <select
        id="siop-consent-person"
        value={person}
        disabled={busy || socialBusy || session !== null}
        onChange={(event) => setPerson(event.target.value)}
      >
        <option value="">Choose a local person</option>
        {people.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function SiopSocialChoices({
  state,
  chooseSocial,
}: {
  state: SiopConsentState;
  chooseSocial: (choice: SiopSocialChoice) => void;
}) {
  const { socialChoices, person, busy, socialBusy, socialProof } = state;
  return (
    <div className="siop-social" aria-label="Social sign-in">
      <h2>Social sign-in</h2>
      {!person ? (
        <StatusMark tone="idle" label="Choose a local person first." />
      ) : null}
      <ul>
        {socialChoices.map((choice) => {
          const brand = brandFor(choice.providerId);
          return (
            <li key={choice.id} className="siop-social__row">
              <button
                type="button"
                className={`icon-btn icon-btn--sm${brand ? ` ${brand.className}` : ""}`}
                aria-label={`Continue with ${choice.label}`}
                title={`Continue with ${choice.label}`}
                disabled={busy || socialBusy || !person || Boolean(socialProof)}
                onClick={() => chooseSocial(choice)}
              >
                {brand ? <brand.Icon size={16} /> : <IconLogin size={16} />}
              </button>
              <span className="go-verb" aria-hidden="true">
                {choice.label}
                {choice.accountLabel ? ` · ${choice.accountLabel}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function consentStatus(state: SiopConsentState): string {
  const { finished, socialProof, session } = state;
  return finished
    ? "Finishing sign-in…"
    : socialProof
      ? `Signed in with ${socialProof.label}. ${session ? "Passkey verified." : "Verify the selected person with a passkey."}`
      : session
        ? "Passkey verified."
        : "Verify to continue.";
}

export function SiopConsentView({
  state,
  actions,
  request,
}: {
  state: SiopConsentState;
  actions: SiopConsentActions;
  request: NormalizedAuthorizationRequest;
}) {
  const {
    finished,
    session,
    busy,
    application,
    redirectOrigin,
    error,
    loaded,
    root,
    people,
    socialChoices,
    socialError,
    socialBusy,
    person,
  } = state;

  return (
    <section
      className="panel"
      aria-label="Self-issued sign-in"
      aria-busy={busy}
    >
      <div className="panel__head">
        <h1>Self-issued sign-in to {application || "an application"}</h1>
      </div>
      <div className="panel__body">
        <p>
          Requesting site:{" "}
          <code className="identity-ref">{redirectOrigin}</code>
        </p>
        <details>
          <summary>Exact callback address</summary>
          <p className="identity-ref">{request.redirectUri}</p>
        </details>
        <p>
          Requested permissions: <code>openid</code>
        </p>
        <p className="hint">Shares no vault contents.</p>
        <FailureNotice
          id="siop-authorize:consent"
          title="Self-issued sign-in"
          message={error}
        />
        {!loaded && !error ? (
          <output>Reading application registration…</output>
        ) : null}
        <div ref={root}>
          {loaded && !finished && !error ? (
            <>
              <SiopPersonSelect state={state} />
              {people.length === 0 ? (
                <p>
                  No enabled people belong to this application&apos;s
                  organization. Assign membership in Identity before signing in.
                </p>
              ) : null}
              {socialChoices.length > 0 && !session ? (
                <SiopSocialChoices
                  state={state}
                  chooseSocial={actions.chooseSocial}
                />
              ) : null}
              {socialError ? (
                <FailureNotice
                  id="siop-authorize:social"
                  title="Social sign-in"
                  message={socialError}
                />
              ) : null}
              <SiopCommit
                signedIn={Boolean(session)}
                busy={busy || socialBusy}
                canVerify={Boolean(person)}
                onAllow={actions.allow}
                onVerify={actions.verifyPasskey}
                onDeny={actions.deny}
              />
            </>
          ) : null}
          <p className="hint">
            <output aria-label="Self-issued sign-in status">
              {consentStatus(state)}
            </output>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The consent's commit: allow once a person has proven themselves, verify
 * with a passkey before that — and deny beside either, on the same row.
 */
function SiopCommit(props: {
  signedIn: boolean;
  busy: boolean;
  canVerify: boolean;
  onAllow: () => void;
  onVerify: () => void;
  onDeny: () => void;
}) {
  const { signedIn, busy } = props;
  const verify = busy ? "Verifying passkey…" : "Verify with passkey";
  return (
    <FormCommit
      label={signedIn ? "Allow Self-Issued sign-in" : verify}
      icon={signedIn ? undefined : <IconPasskey size={18} />}
      disabled={busy || !(signedIn || props.canVerify)}
      onClick={signedIn ? props.onAllow : props.onVerify}
    >
      <IconKey label="Deny" disabled={busy} onClick={props.onDeny}>
        <IconX size={16} />
      </IconKey>
    </FormCommit>
  );
}
