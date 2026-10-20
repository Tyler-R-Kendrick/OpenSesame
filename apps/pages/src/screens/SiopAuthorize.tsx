import { parsePagesSiopRequest } from "@opensesame/app-core/lib/siop-authority.js";
import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { FailureNotice } from "../components/FailureNotice.js";
import { useVault } from "../lib/vault/hooks.js";
import { SiopConsentView } from "../modules/identity.siop/SiopConsentView.js";
import { useSiopConsentActions } from "../modules/identity.siop/siop-consent-actions.js";
import { useSiopConsentState } from "../modules/identity.siop/siop-consent-state.js";

export function SiopAuthorize() {
  const { search } = useLocation();
  const { tomb } = useVault();
  const request = useMemo(() => {
    try {
      return parsePagesSiopRequest(search);
    } catch {
      return null;
    }
  }, [search]);
  if (!request)
    return (
      <section className="panel" aria-label="Self-issued sign-in">
        <div className="panel__head">
          <h1>Invalid Self-Issued request</h1>
        </div>
        <div className="panel__body">
          <FailureNotice
            id="siop-authorize:request"
            title="Invalid Self-Issued request"
            message="Start sign-in again from the registered application."
          />
          <Link to="/identity?view=applications">Manage applications</Link>
        </div>
      </section>
    );
  return (
    <SiopConsent key={`${tomb}:${search}`} tomb={tomb} request={request} />
  );
}

function SiopConsent({
  tomb,
  request,
}: {
  tomb: string;
  request: NormalizedAuthorizationRequest;
}) {
  const state = useSiopConsentState(tomb, request);
  const actions = useSiopConsentActions(tomb, request, state);
  return <SiopConsentView state={state} actions={actions} request={request} />;
}
