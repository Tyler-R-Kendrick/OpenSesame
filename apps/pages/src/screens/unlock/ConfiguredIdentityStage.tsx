import { beginSavedNativeOidc } from "@opensesame/app-core/browser/identity-oidc-dispatch.js";
import { beginSavedNativeSaml } from "@opensesame/app-core/browser/identity-saml-dispatch.js";
import { clearAuthOutcome } from "@opensesame/app-core/lib/auth-outcome.js";
import type { TrustedUpstream } from "@opensesame/app-core/lib/federation.js";
import { operatorUpstream } from "@opensesame/app-core/lib/federation.js";
import {
  type IdentityConnectionDraft,
  beginIdentityConnectionSignIn,
  hydrateIdentityConnections,
  readIdentityConnection,
} from "@opensesame/app-core/lib/identity-connections.js";
import type { OperatorIdp } from "@opensesame/app-core/lib/settings.js";
import { type ReactNode, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IdentityConnectionSignIn } from "../../components/IdentityConnectionSignIn.js";

export type ConfiguredIdentity = { id: string; draft: IdentityConnectionDraft };
export const configuredIdentityDependencies = {
  beginSavedNativeOidc,
  beginSavedNativeSaml,
  beginIdentityConnectionSignIn,
  hydrateIdentityConnections,
  readIdentityConnection,
};

/** Native session adapters ask for credentials; public OIDC keeps its redirect ceremony. */
type ConfiguredIdentityHandlers = {
  open: (connection: ConfiguredIdentity) => void;
  start: (run: () => Promise<void>) => void;
  legacy: (upstream: TrustedUpstream) => Promise<void>;
  fail: (message: string) => void;
};
export function startConfiguredIdentity(
  idp: OperatorIdp,
  handlers: ConfiguredIdentityHandlers,
) {
  const id = idp.connectionId;
  if (!id) {
    handlers.start(() => handlers.legacy(operatorUpstream(idp)));
    return;
  }
  if (idp.protocol === "saml") {
    const pending = configuredIdentityDependencies.beginSavedNativeSaml(id);
    handlers.start(() => pending);
    return;
  }
  if (idp.protocol === "oidc" && idp.nativeIdentity === true) {
    const pending = configuredIdentityDependencies.beginSavedNativeOidc(id);
    handlers.start(() => pending);
    return;
  }
  handlers.start(async () => {
    await configuredIdentityDependencies.hydrateIdentityConnections();
    const draft = configuredIdentityDependencies.readIdentityConnection(id);
    if (!draft) {
      handlers.fail("Identity configuration is no longer available.");
      return;
    }
    if (draft.protocol === "better-auth" || draft.protocol === "supabase")
      handlers.open({ id, draft });
    else await configuredIdentityDependencies.beginIdentityConnectionSignIn(id);
  });
}

export function ConfiguredIdentityStage({
  connection,
  busy,
  setBusy,
  back,
  onComplete,
}: {
  connection: ConfiguredIdentity;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  back: ReactNode;
  onComplete: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="signin">
      {back}
      <IdentityConnectionSignIn
        autoFocus
        failure={error ?? undefined}
        draft={connection.draft}
        busy={busy}
        online={navigator.onLine}
        onSignIn={async (credentials) => {
          setError(null);
          setBusy(true);
          clearAuthOutcome();
          try {
            await configuredIdentityDependencies.beginIdentityConnectionSignIn(
              connection.id,
              { credentials },
            );
            onComplete();
          } catch (caught) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Sign-in did not complete.",
            );
          } finally {
            setBusy(false);
          }
        }}
      />
      <FailureNotice
        id="unlock:configured-identity"
        title="Sign-in"
        message={error}
      />
    </div>
  );
}

type ConfiguredIdentityControllerHandlers = {
  onOpen: () => void;
  onError: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
  start: (run: () => Promise<void>) => void;
  legacy: (upstream: TrustedUpstream) => Promise<void>;
};
export function useConfiguredIdentityController(
  handlers: ConfiguredIdentityControllerHandlers,
) {
  const [connection, setConnection] = useState<ConfiguredIdentity | null>(null);
  function start(idp: OperatorIdp) {
    startConfiguredIdentity(idp, {
      open: (next) => {
        setConnection(next);
        handlers.onError(null);
        handlers.setBusy(false);
        handlers.onOpen();
      },
      fail: (message) => {
        handlers.onError(message);
        handlers.setBusy(false);
      },
      start: handlers.start,
      legacy: handlers.legacy,
    });
  }
  return { connection, start, reset: () => setConnection(null) };
}
