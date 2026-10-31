import { beginSignIn } from "@opensesame/app-core/lib/federation.js";
import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { signInLocalIdentity } from "@opensesame/app-core/lib/local-sessions.js";
import {
  approveSiopAuthorization,
  approveSiopAuthorizationWithSocial,
  denySiopAuthorization,
  recordSiopDenial,
} from "@opensesame/app-core/lib/siop-authority.js";
import type { NormalizedAuthorizationRequest } from "@opensesame/siop-v2";
import {
  type SiopSocialChoice,
  clearSiopSocialAttempt,
  saveSiopSocialAttempt,
  siopSocialReturnTo,
} from "../../lib/siop-social.js";
import { useOnce } from "../../lib/use-once.js";
import type { SiopConsentState } from "./siop-consent-state.js";

function chooseSocial(choice: SiopSocialChoice, state: SiopConsentState): void {
  const {
    busy,
    socialBusy,
    session,
    person,
    finished,
    setSocialError,
    setError,
    setSocialProof,
    setSocialBusy,
  } = state;
  if (busy || socialBusy || session || !person || finished) return;
  setSocialError("");
  setError("");
  if (choice.source === "connection") {
    if (!choice.connectionId) return;
    setSocialProof({
      source: "connection",
      providerId: choice.providerId,
      label: choice.accountLabel
        ? `${choice.label} · ${choice.accountLabel}`
        : choice.label,
      personId: person,
      at: Date.now(),
      connectionId: choice.connectionId,
    });
    return;
  }
  if (!choice.upstream || !choice.upstreamId) return;
  const attempt = {
    id: crypto.randomUUID(),
    source: "identity" as const,
    providerId: choice.providerId,
    label: choice.label,
    personId: person,
    at: Date.now(),
    upstreamId: choice.upstreamId,
  };
  saveSiopSocialAttempt(attempt);
  setSocialBusy(true);
  void beginSignIn(choice.upstream, {
    returnTo: siopSocialReturnTo(attempt.id),
    providerHint: choice.upstream.providerHint,
  }).catch((failure) => {
    clearSiopSocialAttempt();
    setSocialBusy(false);
    setSocialError(
      failure instanceof Error
        ? failure.message
        : "That social sign-in did not start.",
    );
  });
}

async function verifyPasskey(tomb: string, state: SiopConsentState) {
  const {
    busy,
    person,
    finished,
    generation,
    setBusy,
    setSocialError,
    setError,
    setSession,
  } = state;
  if (busy || !person || finished) return;
  const current = generation.current;
  setBusy(true);
  // Social sign-in proves the upstream account; this ceremony also binds the
  // selected local person. Keep that social evidence for the final approval.
  setSocialError("");
  setError("");
  try {
    const identity = await signInLocalIdentity(tomb, person);
    if (current === generation.current) setSession(identity);
  } catch (failure) {
    if (current === generation.current) {
      setSession(null);
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "Sign-in was not completed. Retry with your enrolled passkey.",
      );
    }
  } finally {
    if (current === generation.current) setBusy(false);
  }
}

async function allow(
  tomb: string,
  request: NormalizedAuthorizationRequest,
  state: SiopConsentState,
) {
  const {
    busy,
    session,
    socialProof,
    finished,
    generation,
    setBusy,
    setError,
    setFinished,
    setSession,
  } = state;
  if (busy || (!session && !socialProof) || finished) return;
  const current = generation.current;
  setBusy(true);
  setError("");
  try {
    const approved = socialProof
      ? await approveSiopAuthorizationWithSocial(tomb, socialProof, request)
      : session
        ? await approveSiopAuthorization(tomb, session, request)
        : null;
    if (!approved || current !== generation.current) return;
    const { redirectUrl } = approved;
    setFinished(true);
    globalThis.location.replace(redirectUrl);
  } catch (failure) {
    if (current === generation.current) {
      setSession(null);
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "Self-Issued sign-in was not completed. Retry with your enrolled passkey.",
      );
    }
  } finally {
    if (current === generation.current) setBusy(false);
  }
}

export function useSiopConsentActions(
  tomb: string,
  request: NormalizedAuthorizationRequest,
  state: SiopConsentState,
) {
  const { busy, finished, setFinished } = state;
  // A refusal is recorded once, however fast it is pressed twice: `finished`
  // is this render's, and a second press can land before the next one.
  const refuse = useOnce(async () => {
    setFinished(true);
    await recordSiopDenial(tomb, request);
    globalThis.location.replace(denySiopAuthorization(request));
  });

  function deny() {
    if (busy || finished) return;
    void refuse();
  }

  return {
    chooseSocial: (choice: SiopSocialChoice) => chooseSocial(choice, state),
    verifyPasskey: () => void verifyPasskey(tomb, state),
    allow: () => void allow(tomb, request, state),
    deny,
  };
}

export type SiopConsentActions = ReturnType<typeof useSiopConsentActions>;
